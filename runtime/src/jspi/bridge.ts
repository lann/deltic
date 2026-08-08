// The JSPI ↔ scheduler bridge: turning a blocking canonical built-in into a
// genuinely suspended wasm activation.
//
// This is the phase-1 seam swap. Nothing in the task model changes: `Thread`,
// `BlockRequest` and `waitUntil` are exactly as they were. What changes is
// *who* the parked thing is. For the stackless (callback-ABI) path a parked
// thread is a JS generator; for a stackful one it is a suspended wasm
// activation, and this module is the adapter that makes the two look the same
// to `Store.tick`.
//
// ===========================================================================
// THE INVARIANT
// ===========================================================================
//
//   A component instantiation is EITHER "plain" — no JS→wasm entry is
//   `promising`-wrapped and no import is `Suspending`-wrapped — OR
//   "suspension-capable": every entry that can reach a blocking built-in is
//   `promising`-wrapped, and every blocking built-in is `Suspending`-wrapped.
//   Never a mixture.
//
// This is forced by empirical fact (c), pinned in
// `runtime/tests/jspi/suspending_import_test.ts`: **a `Suspending`-wrapped
// import called outside a promising activation traps unconditionally — even
// on the plain-value fast path.** So `Suspending`-wrapping an intrinsic is not
// a free upgrade; it is only safe if every activation that can reach it is
// promising. Hence one decision per instantiation, not per call site.
//
// It is enforced structurally rather than by convention: the mode is a single
// value computed once by the `Executor` and threaded to both wrapping sites
// (`enterWasm` here, and the trampoline factory in intrinsics/mod.ts). Both
// assert it, and `assertModeConsistent` is called from the instantiation path
// so a mismatch fails loudly at instantiate time rather than as a mystery
// trap much later.
//
// Which entries "can reach a blocking built-in"? Exactly three:
//   * a lifted export's core function,
//   * a callback export (the callback-ABI loop re-enters wasm),
//   * a FACT adapter callee invoked by `{sync,async}-start-call`.
// `realloc`, `post-return` and resource destructors are deliberately NOT
// promising-wrapped: they are guest-internal or spec-forbidden from blocking,
// they never call a canonical built-in, and wrapping them would force their
// results to become Promises where cabi needs a number synchronously.

import { assert_ } from "../cabi/trap.ts";
import { isSupported, makePromising, makeSuspending } from "./mechanics.ts";
import {
  clearResumingThread,
  setResumingThread,
} from "../task/mod.ts";
import type { Cancelled, SchedulableThread, Store } from "../task/mod.ts";

/** Which suspension discipline an instantiation runs under. */
export type SuspensionMode = "plain" | "jspi";

/**
 * Decide the mode for one instantiation.
 *
 * `requested` is the embedder's opt-in. We additionally require the engine to
 * actually implement JSPI: on an engine without it every blocking site falls
 * back to the precise `NeedsJspi` it raised before this module existed, which
 * is the M3 browser-matrix degradation path (PLAN.md §13 M3).
 */
export function chooseMode(
  requested: boolean | undefined,
  needed?: boolean,
): SuspensionMode {
  if (requested === false) return "plain";
  const want = requested === true || needed === true;
  return want && isSupported() ? "jspi" : "plain";
}

/**
 * Does this component contain anything that can block a wasm frame?
 *
 * Computed from the plan, on the runtime side, so embedders (and the
 * conformance harness) stay dumb — no plan v3 field, no flag to thread
 * through. Deliberately a slight over-approximation: it asks "could this
 * component ever reach a blocking built-in", not "will this call". A false
 * positive costs a promising-wrapped entry (the export returns a Promise); a
 * false negative would be a hard trap at the blocking site, so the bias is the
 * safe one.
 *
 * The two sources of blocking, both straight from the reference:
 *
 *   * a **stackful async lift** — async canonical options with no callback
 *     (`canon_lift` line 2179 runs the callee to completion on its own stack);
 *   * a **blocking built-in** reached synchronously — the `sync` form of
 *     `waitable-set.wait`, a stream/future copy or cancel, `subtask.cancel`,
 *     `thread.yield`, or a `sync-start-call` into an async-lifted callee.
 */
export function planNeedsSuspension(plan: {
  canonicalOptions: { async: boolean; callback: number | null }[];
  trampolines: { kind: string }[];
}): boolean {
  for (const o of plan.canonicalOptions) {
    if (o.async && o.callback === null) return true;
  }
  for (const t of plan.trampolines) {
    switch (t.kind) {
      case "sync-start-call":
      case "waitable-set-wait":
      case "thread-yield":
      case "subtask-cancel":
      case "stream-read":
      case "stream-write":
      case "future-read":
      case "future-write":
      case "stream-cancel-read":
      case "stream-cancel-write":
      case "future-cancel-read":
      case "future-cancel-write":
        return true;
    }
  }
  return false;
}

/**
 * Wrap a JS→wasm entry according to the mode.
 *
 * In `plain` mode this is the identity. In `jspi` mode the returned function
 * always yields a Promise (empirical fact (e)), which is why the mode is an
 * embedder opt-in: it changes the shape of every lifted export.
 */
export function enterWasm<T extends (...a: never[]) => unknown>(
  fn: T,
  mode: SuspensionMode,
): T {
  if (mode === "plain") return fn;
  assert_(isSupported(), "jspi mode selected on an engine without JSPI");
  return makePromising(fn as unknown as (...a: unknown[]) => unknown) as unknown as T;
}

/**
 * Wrap a blocking-capable trampoline so that returning a Promise suspends the
 * calling wasm activation. Only legal in `jspi` mode — see the invariant.
 */
export function suspendingImport<T extends (...a: never[]) => unknown>(
  fn: T,
  mode: SuspensionMode,
): T | WebAssembly.Suspending {
  if (mode === "plain") return fn;
  assert_(isSupported(), "jspi mode selected on an engine without JSPI");
  return makeSuspending(fn as unknown as (...a: unknown[]) => unknown);
}

/** Fail loudly at instantiate time if the two wrapping sites disagree. */
export function assertModeConsistent(
  mode: SuspensionMode,
  entriesWrapped: boolean,
  importsWrapped: boolean,
): void {
  assert_(
    (mode === "jspi") === entriesWrapped &&
      (mode === "jspi") === importsWrapped,
    `suspension mode ${mode} is not applied consistently ` +
      `(entries=${entriesWrapped}, imports=${importsWrapped}) — a ` +
      `Suspending import reached from a non-promising activation traps ` +
      `unconditionally (jspi pin (c))`,
  );
}

/**
 * A suspended wasm activation, presented to the scheduler as an ordinary
 * parked thread.
 *
 * `Store.tick` only ever asks a thread three things — is it waiting, is it
 * ready, please resume — so a suspension point that answers those is
 * indistinguishable from a generator-backed `Thread`. Resuming means settling
 * the Promise the `Suspending` import returned, which is what the engine is
 * awaiting; the value handed to `resume` is whatever the reference would have
 * produced at that block point (an event triple's code, a subtask state, a
 * packed copy result).
 */
export class SuspensionPoint<T = unknown> implements SchedulableThread {
  readonly promise: Promise<T>;
  #settle!: (v: T) => void;
  #fail!: (e: unknown) => void;
  #done = false;
  #store: Store;

  constructor(
    store: Store,
    // deno-lint-ignore no-explicit-any
    readonly task: any,
    /** Resumable once this holds; `null` = only an explicit resume. */
    readonly readyFunc: (() => boolean) | null,
    readonly cancellable: boolean,
    /** Produces the value to hand back to wasm at resume time. */
    private readonly produce: (cancelled: Cancelled) => T,
  ) {
    this.#store = store;
    this.promise = new Promise<T>((res, rej) => {
      this.#settle = res;
      this.#fail = rej;
    });
    store.startWaiting(this);
  }

  waiting(): boolean {
    return !this.#done;
  }

  ready(): boolean {
    return !this.#done && this.readyFunc !== null && this.readyFunc();
  }

  /** Settle the import's Promise; the engine resumes the wasm activation. */
  resume(cancelled: Cancelled = false): void {
    assert_(!this.#done, "resume of an already-resumed suspension point");
    this.#done = true;
    this.#store.stopWaiting(this);
    let value: T;
    try {
      value = this.produce(cancelled);
    } catch (e) {
      // A trap computed at resume time (e.g. the event turned out to be a
      // trapping one) must reach the guest as a rejection of the import's
      // Promise, which the engine turns back into a wasm trap — empirical
      // fact (e): post-resume traps arrive as ordinary rejections.
      this.#fail(e);
      return;
    }
    // Claim the ambient for this activation across the engine's resumption:
    // settling the import's Promise hands control to wasm, which will call
    // built-ins with an empty bracket stack. See `setResumingThread`.
    setResumingThread(this.task?.implicitThread ?? null);
    this.#settle(value);
  }

  /** Abandon this suspension without resuming the guest (teardown paths). */
  abandon(reason: unknown): void {
    if (this.#done) return;
    this.#done = true;
    this.#store.stopWaiting(this);
    this.#fail(reason);
  }
}

/**
 * The single shape every blocking built-in needs: "park the calling wasm frame
 * until `readyFunc` holds, then hand it `produce()`".
 *
 * In `plain` mode the caller must not reach here — it raises `NeedsJspi` at
 * its own site, with a message naming the operation, exactly as before. In
 * `jspi` mode this returns a Promise, and because the built-in was
 * `Suspending`-wrapped the engine suspends the activation on it.
 */
export function blockCurrentActivation<T>(input: {
  store: Store;
  // deno-lint-ignore no-explicit-any
  task: any;
  readyFunc: (() => boolean) | null;
  cancellable: boolean;
  produce: (cancelled: Cancelled) => T;
}): Promise<T> {
  const point = new SuspensionPoint<T>(
    input.store,
    input.task,
    input.readyFunc,
    input.cancellable,
    input.produce,
  );
  return point.promise;
}
