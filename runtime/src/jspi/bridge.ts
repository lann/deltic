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
  withActivation,
  claimActivationAmbient,
  dbgId,
  consumeClaimIfRunning,
  maybeCurrentThread,
  releaseActivationAmbient,
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
 * is the M3 browser-matrix degradation path (docs/milestones.md M3).
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
 * Does a call through this trampoline declaration genuinely block — i.e. is
 * it a reason a component NEEDS suspension support at all?
 *
 * Sharper than a kind list, and it must be: the async *form* of every copy /
 * cancel built-in NEVER blocks — it returns `BLOCKED` and delivers the result
 * through an event (definitions.py `stream_copy` line 2537 / `cancel_copy`
 * 2643 / `canon_subtask_cancel` 2476, each `if not async_: ... else return
 * BLOCKED`). Classifying by kind alone marked every instance that imports an
 * async-form built-in as suspension-capable, which promising-wrapped its
 * eagerly-completing FACT callees — and a wrapped eager callee reports
 * STARTED where the reference reports RETURNED, and parks on a
 * non-cancellable `awaitValue` where the reference delivers a synchronous
 * cancellation (both asserted by big-interleaving-test.wast's expect-codes).
 *
 * Where the async-ness lives varies by kind, following wasmtime's trampoline
 * layout (component/info.rs): copy built-ins carry an options index (the
 * flag is `canonicalOptions[i].async`); the cancel forms and `subtask.cancel`
 * carry `async` on the declaration itself; `waitable-set.wait`,
 * `thread.yield` and `sync-start-call` are unconditionally block-capable
 * (their non-blocking counterparts are separate kinds: poll, the YIELD
 * callback code, async-start-call).
 */
export function trampolineNeedsSuspension(
  t: { kind: string; async?: unknown; options?: unknown },
  optionsAsync: (index: number) => boolean,
): boolean {
  switch (t.kind) {
    case "sync-start-call":
    case "waitable-set-wait":
    case "thread-yield":
      return true;
    case "subtask-cancel":
    case "stream-cancel-read":
    case "stream-cancel-write":
    case "future-cancel-read":
    case "future-cancel-write":
      return t.async !== true;
    case "stream-read":
    case "stream-write":
    case "future-read":
    case "future-write":
      return typeof t.options === "number" ? !optionsAsync(t.options) : true;
    default:
      return false;
  }
}

/**
 * Must the executor hand this trampoline to wasm as a `Suspending` import in
 * jspi mode?
 *
 * A superset of `trampolineNeedsSuspension` by exactly two kinds, both for
 * the same reason: they never block in the reference or in plain mode, but
 * under jspi they may park the CALLER until a callee's state is determinate,
 * because the engine defers a resumed activation's continuation to a
 * microtask (jspi pin (j), `fastpath_hop_test.ts`):
 *
 *   * `async-start-call` — parks until the freshly-started callee reaches
 *     resolution / completion / a genuine block (fact_calls.ts);
 *   * the async form of `subtask.cancel` — parks until a cancellation
 *     delivered by settling the callee's suspension has actually landed
 *     (async_builtins.ts; cancellable.wast asserts the reference's
 *     synchronous-delivery answers).
 *
 * Neither is a *reason* to choose jspi mode, and neither marks its importer
 * suspendable (`Executor.suspendableFuncs`): their parks only ever trigger
 * when the nested callee is itself promising-wrapped, i.e. when a genuine
 * blocker has already contaminated the adapter through the transitive import
 * rule. Marking on these kinds is not only unnecessary — it is wrong: the
 * FACT adapter's `[adapter-callee]*` pass-through exports are what get
 * passed to `*-start-call` as lift callees, and marking the whole adapter
 * instance promoted every eagerly-completing callee to promising, recreating
 * the STARTED-vs-RETURNED divergence one level up.
 */
export function trampolineCanBlock(
  t: { kind: string; async?: unknown; options?: unknown },
  optionsAsync: (index: number) => boolean,
): boolean {
  return t.kind === "async-start-call" || t.kind === "subtask-cancel" ||
    trampolineNeedsSuspension(t, optionsAsync);
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
 *   * a **blocking built-in** reached synchronously — see
 *     `trampolineNeedsSuspension`.
 */
export function planNeedsSuspension(plan: {
  canonicalOptions: { async: boolean; callback: number | null }[];
  trampolines: { kind: string; async?: unknown; options?: unknown }[];
}): boolean {
  for (const o of plan.canonicalOptions) {
    if (o.async && o.callback === null) return true;
  }
  const optionsAsync = (i: number) => plan.canonicalOptions[i]?.async === true;
  for (const t of plan.trampolines) {
    if (trampolineNeedsSuspension(t, optionsAsync)) return true;
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
 *
 * The wrapper around `fn` is ambient claim site (ii) (scheduler.ts), and the
 * one that is easy to miss: **every** call through a `Suspending` import returns to
 * wasm through a microtask hop, even when the import produced its value
 * synchronously and nothing suspended (jspi pin (j),
 * `tests/jspi/fastpath_hop_test.ts`). The rest of the guest's frame therefore
 * runs after our JS frames — `awaitCore`'s `withActivation` bracket included —
 * have unwound, with no `SuspensionPoint` anywhere in sight to have claimed
 * it. Measured signature when this is missing: a FACT adapter's
 * `enter-sync-call` runs bracketed and its `exit-sync-call` runs with no
 * ambient at all ("exit-sync-call with an empty sync-call stack",
 * `trap-if-done.wast:448`, `big-interleaving-test.wast`). This is the site the
 * async-context store used to cover for free, because the engine
 * captured the context when it registered the hop.
 *
 * The claim is only taken on the NON-suspending outcomes. A returned Promise
 * is a genuine suspension whose resumption `SuspensionPoint.resume` claims
 * exactly, and `blockCurrentActivation` has just released this activation's
 * claim on the way in — re-adding it here would strand it.
 */
// ---------------------------------------------------------------------------
// Continuation-chunk attribution sentinels (issue #24)
// ---------------------------------------------------------------------------
//
// PROBLEM. Engine continuation chunks — the segments of a promising wasm
// activation between suspension/hop points — begin as promise REACTIONS,
// with no synchronous signal to this runtime. When several activations have
// pending continuations (a settled real suspension racing a fast-path hop,
// or two fast-path hops from nested entries), the chunks interleave at an
// empty bracket stack, and every ambient read in a later chunk — a hop's
// `owner` capture at `claimingFn` entry, or an unsafe intrinsic like
// `context.set`, which has no hop at all — inherits whatever claim the
// previous chunk left on top. Claim-stack ordering alone cannot repair
// this: the release edges are themselves promise reactions. Measured
// consequence (issue #24): wit-bindgen's callback epilogue restored one
// task's state pointer into another thread's context slots, and the next
// invocation of the starved thread's callback hit
// `assert!(!state.is_null())` (async_support.rs:578) -> unreachable.
// Reachable only with enough concurrently-suspended sibling activations
// (first corpus: polymorph-tls' webcrypto-composed suite, three async
// wit-bindgen components deep).
//
// FIX. Exploit the one ordering guarantee the platform does give us:
// microtasks run FIFO, and between our code queueing a microtask and the
// engine queueing the continuation reaction there is only synchronous
// engine-internal promise machinery. So at EVERY point where an engine
// continuation is about to be queued, queue a SENTINEL first that claims
// the chunk's owner (move-to-top):
//
//   * fast-path hop: sentinel queued synchronously in `claimingFn` before
//     returning the plain value — the engine queues the hop reaction while
//     processing that return, so the queue reads [sentinel, chunk].
//   * genuine suspension: the wrapper attached to the import's thenable
//     queues the sentinel inside the settle reaction, before returning the
//     value — the engine (attached to the WRAPPED promise) queues the
//     resumption when that wrapper returns, so again [sentinel, chunk].
//     This holds even when several promises settle in one drain: each
//     pair is queued contiguously from within its own settle reaction.
//
// Nothing is delayed or reordered — unlike a serializing gate, which
// measurably shifted the deterministic-profile backpressure-admission
// order (async-calls-sync.wast caught it). This is the JSPI substitute for
// what fibers give wasmtime for free: identity travels with the
// resumption, here as a claim planted one microtask ahead of it.

function sentinelFor(owner: unknown): void {
  if (owner === null || owner === undefined) return;
  // `Promise.resolve().then`, not `queueMicrotask`: identical FIFO
  // placement, but the latter does not exist in bare engine shells
  // (SpiderMonkey jsshell; sm-pinned lane caught it).
  SENTINEL_TICK.then(() => claimActivationAmbient(owner));
}
const SENTINEL_TICK = Promise.resolve();

/** Wrap a suspending import's thenable so the eventual resumption chunk is
 * preceded contiguously by its attribution sentinel. */
function attributeContinuation<T>(owner: unknown, r: PromiseLike<T>): Promise<T> {
  return Promise.resolve(r).then(
    (v) => {
      sentinelFor(owner);
      return v;
    },
    (e) => {
      sentinelFor(owner);
      throw e;
    },
  );
}

export function suspendingImport<T extends (...a: never[]) => unknown>(
  fn: T,
  mode: SuspensionMode,
): T | WebAssembly.Suspending {
  if (mode === "plain") return fn;
  assert_(isSupported(), "jspi mode selected on an engine without JSPI");
  const claimingFn = (...args: unknown[]): unknown => {
    // The activation calling us — read while its bracket (or its hop claim)
    // is still the ambient.
    const owner = maybeCurrentThread() ?? null;
    const invoke = () => (fn as unknown as (...a: unknown[]) => unknown)(...args);
    let r: unknown;
    try {
      // Bracket our own JS frame with the caller. Without this, a built-in
      // that synchronously enters ANOTHER activation's wasm (`async-start-call`
      // running its callee through `awaitCore`) leaves that callee's hop claim
      // on top when the callee suspends, and the rest of OUR frame — still the
      // caller's — then reads the callee as the ambient (measured on
      // `fact_calls.ts:820`'s determinacy wait). The nesting is a stack, and
      // this is the frame that owns it.
      r = owner === null ? invoke() : withActivation(owner, invoke);
    } catch (e) {
      // A synchronous trap out of a built-in also unwinds the guest through
      // the hop, and the guest's trap-path built-ins run there.
      claimActivationAmbient(owner);
      throw e;
    }
    if (r === null || typeof (r as { then?: unknown })?.then !== "function") {
      // Fast path (jspi pin (j)): the value still returns to wasm through an
      // engine microtask hop, so the rest of the caller's frame is an engine
      // continuation chunk like any other. The synchronous claim covers any
      // reads before the hop; the sentinel re-claims contiguously ahead of
      // the hop reaction (see the header above — issue #24's second shape
      // was exactly a fast-path hop chunk misattributed after a sibling's
      // claim intervened).
      claimActivationAmbient(owner);
      sentinelFor(owner);
      return r;
    }
    if (SP_TRACE) {
      console.error(`[sp] hop-suspend owner=${dbgId(owner)} promise=${dbgId(r)}`);
    }
    return attributeContinuation(owner, r as PromiseLike<unknown>);
  };
  return makeSuspending(claimingFn);
}

/**
 * Fail loudly at instantiate time if the two wrapping sites disagree.
 *
 * The dangerous direction, per jspi pin (c), is a `Suspending` import
 * reachable from a non-`promising` activation — that traps unconditionally,
 * even on the plain-value path. Entry wrapping in jspi mode is unconditional
 * (every lifted export, callback, and block-capable FACT callee), so the
 * structural invariant is `importsWrapped ⇒ entriesWrapped`, per mode.
 *
 * Entries-without-imports is legitimate: per-declaration classification
 * (`trampolineNeedsSuspension`) wraps no imports in a component whose
 * built-ins are all non-blocking async forms, while the mode can still be
 * jspi via the lift-shape over-approximation in `planNeedsSuspension`
 * (canonical options carrying `async` with no callback are counted whether
 * they belong to a lift or to a copy built-in — the plan does not say which,
 * and the false positive only costs Promise-shaped exports).
 */
export function assertModeConsistent(
  mode: SuspensionMode,
  entriesWrapped: boolean,
  importsWrapped: boolean,
): void {
  if (mode === "plain") {
    assert_(
      !entriesWrapped && !importsWrapped,
      `plain mode with wrapped entries=${entriesWrapped} / ` +
        `imports=${importsWrapped} — wrapping ran under the wrong mode`,
    );
    return;
  }
  assert_(
    entriesWrapped || !importsWrapped,
    `suspension mode jspi wrapped imports without wrapping any entry ` +
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
const SP_TRACE = (() => {
  try {
    return Deno.env.get("CE_SP_TRACE") === "1";
  } catch {
    return false;
  }
})();

export class SuspensionPoint<T = unknown> implements SchedulableThread {
  readonly promise: Promise<T>;
  #settle!: (v: T) => void;
  #fail!: (e: unknown) => void;
  #done = false;
  #store: Store;

  /**
   * WHO the engine will resume when this point's promise settles.
   *
   * Captured HERE, at construction, and not derived at resume time: the
   * blocking built-in that mints this point is running under the suspending
   * activation's own ambient, so the ambient names that activation exactly.
   * This is the replacement for the async-context store the scheduler
   * used to rely on (M3A-1): same value, obtained by construction instead of
   * by asking the platform to carry a context across the engine's resumption.
   * `task.implicitThread` is the fallback for the one shape that has no
   * ambient at all — a built-in reached during instantiation.
   */
  // deno-lint-ignore no-explicit-any
  readonly owner: any;

  constructor(
    store: Store,
    // deno-lint-ignore no-explicit-any
    readonly task: any,
    /** Resumable once this holds; `null` = only an explicit resume. */
    readonly readyFunc: (() => boolean) | null,
    readonly cancellable: boolean,
    /** Produces the value to hand back to wasm at resume time. */
    private readonly produce: (cancelled: Cancelled) => T,
    // deno-lint-ignore no-explicit-any
    owner?: any,
  ) {
    this.#store = store;
    this.owner = owner ?? maybeCurrentThread() ?? task?.implicitThread ?? null;
    if (SP_TRACE) {
      console.error(`[sp] mint ${dbgId(this)} owner=${dbgId(this.owner)} task=${dbgId(this.task)}\n${(new Error().stack ?? "").split("\n").slice(2, 5).join("\n")}`);
    }
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
    if (SP_TRACE) {
      console.error(`[sp] resume ${dbgId(this)} owner=${dbgId(this.owner)}\n${(new Error().stack ?? "").split("\n").slice(2, 5).join("\n")}`);
    }
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
      //
      // This is a RESUMPTION too: the engine hands control back to the wasm
      // activation (to unwind it), and the guest's FACT adapter runs its
      // trap-path built-ins — `exit-sync-call` among them — before our own
      // continuation regains control. So it takes the ambient claim exactly
      // like the value path. Missing it here is what `trap-if-done.wast:448`
      // and the `assert_trap` rows of `big-interleaving-test.wast` detect
      // ("exit-sync-call with an empty sync-call stack").
      if (maybeCurrentThread() === undefined) claimActivationAmbient(this.owner);
      setResumingThread(this.task?.implicitThread ?? null);
      this.#fail(e);
      return;
    }
    // Claim the ambient for this activation across the engine's resumption:
    // settling the import's Promise hands control to wasm, which will call
    // built-ins with an empty bracket stack. The claim names `owner` — the
    // activation captured when this point was minted — not a guess derived
    // now; see `owner` and `setResumingThread`.
    //
    // If the DRIVER's slot is live for the activation currently executing (it
    // is the code that called us — a running guest's `subtask.cancel`
    // delivering a cancellation settles the callee's suspension from inside
    // its own frame), that claim has served its purpose; consume it rather
    // than false-positive the one-claimant assert.
    consumeClaimIfRunning();
    // The activation-ambient claim (site (i) in scheduler.ts). Taken only when
    // NOBODY is running right now: if a guest activation is executing, `owner`
    // does not run until that activation yields, and pushing onto a
    // LAST-IN-FIRST-OUT stack now would make `owner` the ambient for the
    // caller's remaining frame. In that shape `owner` is picked up either by
    // its own first `Suspending` call (site (ii)) or, before that, by the
    // driver's `resumingThread` slot at the bottom tier — exactly as it always
    // was.
    if (maybeCurrentThread() === undefined) claimActivationAmbient(this.owner);
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
  // DELTIC-ONLY DIVERGENCE — release-at-resolution. [CORRECTED 2026-08-10:
  // the wasmtime attribution below was wrong. wasmtime HOLDS its entry gate
  // (`ConcurrentInstanceState.do_not_enter`) for the whole core invocation,
  // across post-`task.return` mid-frame parks — same lifetime as the
  // reference's `exclusive_thread`; its sync-streams.wast pass comes from
  // deferred entry evaluation + FIFO scheduling, not gate release. See
  // exams/wasmtime-exclusivity/wasmtime-actual-semantics.md. This block is
  // slated for removal by the hold + deferred-entry migration, issue #43.]
  //
  // Current shipping behavior: a RESOLVED task whose implicit thread blocks
  // mid-frame stops gating its instance's entry. The reference holds
  // `inst.exclusive_thread` from `enter_implicit_thread` until the callback
  // loop's per-wait release or `exit_implicit_thread`, so a producer that
  // calls `task.return` and then blocks in a synchronous `stream.write`
  // (test/async/sync-streams.wast) keeps every later task gated at entry —
  // an async-lowered call into the instance reports STARTING under the
  // reference's eager entry check. Releasing here makes sync-streams.wast
  // pass under deltic's eager check; wasmtime reaches the same green via
  // deferred entry with the gate held.
  //
  // The release is deliberately AT THE BLOCK, not at resolution: releasing
  // at `task.return` freed the slot mid-activation for tasks that resolve
  // and then return a WAIT code (the ordinary producer shape), reordering
  // the backpressure queue that async-calls-sync.wast's guest asserts under
  // the deterministic profile (the handshake pins caught it). A task whose
  // slot was released here never retakes it: `runCallbackLoop` treats a
  // resolved non-holder as outside the exclusivity protocol, and
  // `exit_implicit_thread` releases only if held.
  const task = input.task as {
    state?: string;
    implicitThread?: unknown;
    ft?: { async?: boolean };
    needsExclusive?(): boolean;
    inst?: { exclusiveThread: unknown };
  } | null;
  if (
    task !== null && task?.state === "resolved" &&
    task.ft?.async === true && task.needsExclusive?.() &&
    task.inst !== undefined &&
    task.inst.exclusiveThread === task.implicitThread &&
    task.implicitThread !== null
  ) {
    task.inst.exclusiveThread = null;
  }
  // WHO is parking — read BEFORE anything below disturbs the ambient. This
  // one value serves both purposes: it is the activation the engine will
  // resume when this point settles (`SuspensionPoint.owner`, the replacement
  // for the retired async-context store), and it is the activation whose
  // ambient claim ends here. Reading it after the release yields `undefined`
  // and strands the point with no owner (measured: `cancellable.wast:322`
  // then reported `pending-capability: instantiation-time task context`).
  const owner = maybeCurrentThread() ?? input.task?.implicitThread ?? null;
  // The activation is parking: if it still carried the resumed-ambient claim
  // from the settle that resumed it, that claim's window closes here (the
  // other closing edge — the activation FINISHING — is handled by
  // `Store.noteAwaiting`'s settle continuation).
  consumeClaimIfRunning();
  releaseActivationAmbient(owner);
  const point = new SuspensionPoint<T>(
    input.store,
    input.task,
    input.readyFunc,
    input.cancellable,
    input.produce,
    owner,
  );
  return point.promise;
}
