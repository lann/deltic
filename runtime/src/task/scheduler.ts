// The 0.3 task scheduler (PLAN.md §6) — the `Store` of definitions.py plus
// the current-thread context that every canonical built-in reads.
//
// ===========================================================================
// SCHEDULING POLICY (orchestrator decision, PLAN.md §16)
// ===========================================================================
//
// definitions.py makes two explicitly nondeterministic choices:
//
//   * `Store.tick` (line 597):  `random.choice(list(candidates))` over ready
//     threads;
//   * `WaitableSet.get_pending_event` (line 821): `random.shuffle(self.elems)`
//     before picking a waitable with a pending event;
//   * `Thread.wait_until` (line 396): `if ready_func() and not
//     DETERMINISTIC_PROFILE and random.randint(0,1): return` — an optional
//     "don't block even though you could" fast path.
//
// All three are *allowed* nondeterminism, not required: any single consistent
// choice is a conforming schedule. This scheduler therefore runs a
// **deterministic FIFO ready queue** by default — candidates are resumed in
// the order they became ready, waitable sets deliver events in join order,
// and `wait_until` always blocks (the reference's `DETERMINISTIC_PROFILE`
// branch). Reproducible schedules are worth a great deal when debugging a
// concurrency bug, and FIFO is also the fairest of the cheap policies.
//
// Setting `CE_SCHED_SEED=<integer>` switches to a **seeded shuffle**: the same
// choice points become pseudo-random but reproducible from the seed, which is
// how we explore the schedule space that the FIFO default deliberately pins.
// A test that passes under FIFO but fails under some seed has found a real
// order-dependence — in our runtime or in the guest. The seed is read once at
// module load; `schedulerSeedForTesting` exists so tests can drive both modes
// without a subprocess.
//
// ===========================================================================
// THREADS WITHOUT STACK SWITCHING
// ===========================================================================
//
// definitions.py implements `Thread` on real OS threads with lock handoff
// (`cont_new`/`resume`/`block`, lines 270-305) purely to get one-shot
// continuations. We get the same structure from **JS generators**: a thread
// body is a generator function that `yield`s a block request and is resumed
// by `next(cancelled)`. That is a faithful model precisely because the
// stackless (callback-ABI) path never blocks *inside* a wasm frame — every
// wasm call returns a callback code before the host decides to wait. Blocking
// inside a wasm frame (stackful async lifts; a sync lower on an unresolved
// subtask) genuinely requires JSPI and is M2 phase 3; those sites fail loudly
// rather than pretending (see `needsJspi`).

import { AsyncLocalStorage } from "node:async_hooks";
import { assert_, trapIf } from "../cabi/trap.ts";

/** definitions.py `Cancelled` (line 248). */
export const CANCELLED_FALSE = false;
export const CANCELLED_TRUE = true;
export type Cancelled = boolean;

/**
 * What a thread body yields when it wants to stop running. Mirrors the
 * reference's `Thread.wait_until` (`ready_func` + `cancellable`); `suspend`
 * is `wait_until` with no ready condition (`ready_func === null`), and
 * `yield_` is `wait_until(() => true)`.
 */
export interface BlockRequest {
  /** Resumable once this returns true; `null` = only an explicit resume. */
  readyFunc: (() => boolean) | null;
  cancellable: boolean;
  /**
   * JSPI seam. When present the thread is not waiting on a scheduler
   * condition at all — it is waiting for a **Promise**, namely the one a
   * `promising`-wrapped wasm entry returned. The driving loop awaits it and
   * resumes the body with the resolved value (or throws the rejection into
   * the body, so a post-resume trap unwinds exactly like a synchronous one —
   * jspi pin (e)).
   *
   * This is what lets one generator body serve both modes: in plain mode the
   * core call returns a value and the body never yields such a request, so
   * the synchronous path is bit-for-bit what it was before JSPI existed.
   */
  awaitValue?: Promise<unknown>;
}

/**
 * A thread body: yields block requests, and receives back either the
 * cancelled flag (for a scheduler block point) or the resolved value of an
 * `awaitValue` request.
 */
// deno-lint-ignore no-explicit-any
export type ThreadBody = Generator<BlockRequest, void, any>;

/**
 * Failure raised where the reference genuinely needs to suspend a wasm frame.
 *
 * This is deliberately *not* a `Trap`: the component is not at fault and the
 * program is not ill-formed — our runtime is incomplete. Reporting it as a
 * trap would let a conformance run score a missing capability as a correct
 * rejection, which is the exact failure mode contracts/plan-format.md's
 * error-phase split exists to prevent.
 */
export class NeedsJspi extends Error {
  constructor(what: string) {
    super(`needs JSPI (M2 phase 3): ${what}`);
    this.name = "NeedsJspi";
  }
}

export function needsJspi(what: string): never {
  throw new NeedsJspi(what);
}

/**
 * Failure raised where a capability scheduled for a later M2 phase is
 * required. Same rationale as `NeedsJspi`: never a `Trap`.
 */
export class PendingCapability extends Error {
  constructor(what: string) {
    super(`pending-capability: ${what}`);
    this.name = "PendingCapability";
  }
}

// ---------------------------------------------------------------------------
// Deterministic choice
// ---------------------------------------------------------------------------

function readSeed(): number | null {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("CE_SCHED_SEED");
  } catch {
    // No env permission: FIFO. Never fail to *run* because we could not read
    // a debugging knob.
    return null;
  }
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n) >>> 0;
}

let seed: number | null = readSeed();
let rngState = 0;

/** Test hook: switch policy at runtime. `null` restores FIFO. */
export function schedulerSeedForTesting(value: number | null): void {
  seed = value === null ? null : value >>> 0;
  rngState = seed ?? 0;
}

export function schedulerPolicy(): "fifo" | "seeded-shuffle" {
  return seed === null ? "fifo" : "seeded-shuffle";
}

/** xorshift32 — small, deterministic, and adequate for schedule exploration. */
function nextRandom(): number {
  let x = rngState || 0x9e3779b9;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  rngState = x;
  return x;
}

/**
 * Pick one candidate. FIFO (index 0 — candidates are supplied in
 * ready-order) unless a seed is configured, in which case a seeded uniform
 * choice, mirroring the reference's `random.choice`.
 */
export function chooseCandidate<T>(candidates: readonly T[]): T {
  assert_(candidates.length > 0, "chooseCandidate on an empty candidate set");
  if (seed === null) return candidates[0];
  return candidates[nextRandom() % candidates.length];
}

// ---------------------------------------------------------------------------
// Current-thread context (definitions.py `current_thread`, line 306)
// ---------------------------------------------------------------------------

/**
 * The reference keeps the running thread in a thread-local
 * (`thread_local_handler`). A JS generator has no such ambient slot, so the
 * scheduler maintains an explicit stack: `resume()` pushes, and every
 * canonical built-in reads the top. It is a stack rather than a single slot
 * because a *host* import called from a guest can lift into another component
 * instance, nesting one activation inside another exactly as the reference's
 * recursive `store.lift` does.
 */
// deno-lint-ignore no-explicit-any
const threadStack: any[] = [];

// The concrete Thread type lives in ./thread.ts; typing this stack as the
// structural minimum avoids an import cycle (thread.ts needs the scheduler
// for chooseCandidate, the scheduler needs the stack for current_thread).
export interface CurrentThreadLike {
  storage: number[];
  // deno-lint-ignore no-explicit-any
  task: any;
}

export function pushCurrentThread(t: CurrentThreadLike): void {
  threadStack.push(t);
}

export function popCurrentThread(t: CurrentThreadLike): void {
  const top = threadStack.pop();
  assert_(top === t, "current-thread stack imbalance");
}

/** definitions.py `current_thread()` (line 306). */
/**
 * The activation whose suspension we have just resolved, if any.
 *
 * JSPI resumption happens in a microtask of the engine's own, outside every JS
 * frame we control, so the `threadStack` bracket is empty when the resumed
 * wasm calls a built-in. Empirically (pinned in
 * `runtime/tests/jspi/ambient_test.ts`) the ordering is:
 *
 *     resolve(T's suspension)  ->  T's wasm resumes and calls its built-ins
 *                              ->  T's promising Promise settles
 *                              ->  our own await continuation
 *
 * so between resolving T and regaining control ourselves, **any** built-in
 * call that finds an empty bracket belongs to T. JS being single-threaded is
 * what makes that airtight: no other activation can be executing in that
 * window. `resumingThread` is that claim, and it is asserted rather than
 * assumed — a second claimant while one is live is a bug, never a guess.
 */
// deno-lint-ignore no-explicit-any
let resumingThread: any = null;

/**
 * Activation-attached ambient (jspi pin (h)).
 *
 * The `resumingThread` slot below covers resumptions *we* drive. It cannot
 * cover the ones we do not: a **background activation** — one whose lifted
 * call has already returned — is resumed by the engine whenever its
 * suspension settles, outside every frame and every driving loop we own.
 * Tracing a FACT sync-call bracket that spanned a suspension showed exactly
 * that: `enter-sync-call` ran under a task, the matching `exit-sync-call` ran
 * with no ambient at all.
 *
 * An ambient that survives an undriven resumption has to travel *with the
 * activation*, which is what an async-context store does: the engine registers
 * its resumption continuation on our Promise at suspension time, inside our
 * frame, so the context is captured and restored. Pinned by
 * `runtime/tests/jspi/ambient_test.ts` pin (h).
 */
// deno-lint-ignore no-explicit-any
const activationAls = new AsyncLocalStorage<any>();

/** Run `fn` with `t` as the activation-attached ambient. */
// deno-lint-ignore no-explicit-any
export function withActivation<T>(t: any, fn: () => T): T {
  return activationAls.run(t, fn);
}

/** Claim the ambient for `t` across an engine-driven resumption. */
// deno-lint-ignore no-explicit-any
export function setResumingThread(t: any): void {
  assert_(
    resumingThread === null || resumingThread === t,
    "two activations claim the resumed ambient at once — the " +
      "resolve-one-per-turn discipline was violated",
  );
  resumingThread = t;
}

/** Is a settled-but-not-yet-run activation holding the ambient? */
export function hasResumingThread(): boolean {
  return resumingThread !== null;
}

/** Release the claim; called once we are back in our own continuation. */
export function clearResumingThread(): void {
  resumingThread = null;
}

const AMBIENT_TRACE = (() => {
  try {
    return Deno.env.get("CE_AMBIENT_TRACE") === "1";
  } catch {
    return false;
  }
})();

/** Diagnostic: module-scope state that must NOT survive a completed call. */
export function ambientResidue(): { stack: number; claim: boolean } {
  return { stack: threadStack.length, claim: resumingThread !== null };
}

export function currentThread<T = CurrentThreadLike>(): T {
  const stackTop = threadStack[threadStack.length - 1];
  const als = activationAls.getStore();
  if (AMBIENT_TRACE && stackTop === undefined && resumingThread !== null) {
    console.error(
      `[ambient] slot-vs-als agree=${resumingThread === als} ` +
        `slot=${resumingThread?.constructor?.name ?? "null"} ` +
        `als=${als?.constructor?.name ?? "undefined"} ` +
        `alsPresent=${als !== undefined}`,
    );
  }
  // Precedence: synchronous bracket, then the ACTIVATION-ATTACHED ambient,
  // then the global claim as a last resort. ALS must outrank the slot: the
  // slot names whichever activation the driver happened to claim across an
  // await, so while several activations are in flight it is simply wrong for
  // all but one of them, whereas the ALS store travels with the activation by
  // construction (pin (h)).
  const t = threadStack[threadStack.length - 1] ?? als ?? resumingThread ??
    undefined;
  if (t === undefined) {
    // Reaching this is not an internal invariant violation, so it must not be
    // an `AssertionError`: it is a *known incompleteness*. wasmtime lets a
    // core module's start function call canonical built-ins during
    // instantiation, before any task exists, and definitions.py has no model
    // for that — `current_thread()` (line 306) simply presumes a running
    // task, because in the reference a built-in is only ever reached from
    // inside one.
    //
    // Instance-scoped built-ins already avoid this by taking their instance
    // from the trampoline declaration (see intrinsics/async_builtins.ts). What
    // lands here is a *task*-scoped built-in (task.return, task.cancel,
    // thread.yield, subtask.*) called at instantiation time, which needs the
    // instantiation-time task context the spec implies but does not spell out.
    // Exercised by test/async/dont-block-start.wast:3.
    throw new PendingCapability(
      "instantiation-time task context — a task-scoped canonical built-in " +
        "ran outside any task (a core start function calling task.return / " +
        "task.cancel / thread.yield / subtask.*; see " +
        "test/async/dont-block-start.wast)",
    );
  }
  return t as T;
}

export function maybeCurrentThread(): CurrentThreadLike | undefined {
  return threadStack[threadStack.length - 1] ?? als2() ?? resumingThread ??
    undefined;
}
function als2(): CurrentThreadLike | undefined {
  return activationAls.getStore();
}

/** definitions.py `current_task()` (line 309). */
// deno-lint-ignore no-explicit-any
export function currentTask(): any {
  return currentThread().task;
}

/**
 * The running task, or `null` outside any task — e.g. a core module's start
 * function during instantiation, which the reference has no model for.
 */
// deno-lint-ignore no-explicit-any
export function maybeCurrentTask(): any | null {
  return maybeCurrentThread()?.task ?? null;
}

/** definitions.py `current_instance()` (line 312). */
// deno-lint-ignore no-explicit-any
export function currentInstance(): any {
  return currentTask().inst;
}

// ---------------------------------------------------------------------------
// Store (definitions.py `class Store`, line 562)
// ---------------------------------------------------------------------------

/** Structural view of a Thread, as the store's ready queue needs it. */
export interface SchedulableThread {
  ready(): boolean;
  waiting(): boolean;
  resume(cancelled?: Cancelled): void;
  // deno-lint-ignore no-explicit-any
  task: any;
}

/**
 * The embedder-visible scheduler state (definitions.py `Store`). One per
 * instantiated component in this runtime — the reference shares one `Store`
 * across component instances of a linked graph, and so do we: `Executor`
 * creates a single `Store` and hands it to every `ComponentInstanceState`.
 *
 * `waiting` is kept as an **array, in insertion order**, which is what makes
 * the default policy FIFO: `readyCandidates()` preserves the order in which
 * threads started waiting.
 */
export class Store {
  readonly waiting: SchedulableThread[] = [];
  nestingDepth = 0;

  /**
   * Host-import promises this store is waiting on. Non-empty means progress
   * is possible but only after a microtask turn — see `drive` in
   * exec/boundary.ts. (definitions.py has no analogue: its host functions run
   * on real threads.)
   */
  readonly pendingHostCalls = new Set<Promise<unknown>>();

  /**
   * An exception raised by a host import's promise (a rejection, or a trap
   * thrown while lowering its results). It cannot propagate out of the
   * microtask that produced it, so it is parked here and rethrown by whoever
   * is driving the store — which is the call the guest is blocked in.
   */
  hostFailure: unknown = undefined;

  startWaiting(t: SchedulableThread): void {
    assert_(!this.waiting.includes(t), "thread already in the waiting list");
    this.waiting.push(t);
  }

  stopWaiting(t: SchedulableThread): void {
    const i = this.waiting.indexOf(t);
    assert_(i !== -1, "thread not in the waiting list");
    this.waiting.splice(i, 1);
  }

  /** Ready waiting threads, in wait order (the FIFO of the default policy). */
  readyCandidates(): SchedulableThread[] {
    return this.waiting.filter((t) => t.ready());
  }

  /**
   * Threads parked on a Promise (the jspi `awaitValue` seam). They are not in
   * `waiting` — nothing the scheduler can do makes them ready — so the driving
   * loop tracks them separately and resumes them when their promise settles.
   */
  // deno-lint-ignore no-explicit-any
  readonly awaiting = new Set<any>();

  /**
   * definitions.py `Store.tick` (line 597): resume one ready thread, bracketed
   * by the reentrance gate for a host-initiated entry (`enter_from(None)` /
   * `leave_to(None)`).
   *
   * Returns false when no thread was ready, so callers can distinguish
   * "made progress" from "stuck" without inspecting the queue themselves.
   */
  tick(): boolean {
    // One suspension resolved per turn.
    //
    // Settling a suspension hands control to wasm in a *microtask*, not
    // synchronously — so `tick` returns with the resumed activation not yet
    // run and its ambient claim still outstanding. Resolving a second one
    // before that happens would overwrite the claim, and the first
    // activation's built-ins would then attribute themselves to the wrong
    // task (observed as `exit-sync-call` popping another task's bracket).
    // Refusing to make progress while a claim is live forces the caller to
    // yield to the microtask queue first, which is exactly what `driveAsync`
    // does.
    if (resumingThread !== null) return false;
    const candidates = this.readyCandidates();
    if (candidates.length === 0) return false;
    const thread = chooseCandidate(candidates);
    const inst = thread.task.inst;
    // The reference asserts this precondition in `tick` rather than checking
    // it: a waiting thread's instance is always re-enterable from the host,
    // because whoever entered it has since left or is itself waiting.
    assert_(
      inst.mayEnterFrom(null),
      "tick: waiting thread's instance is not enterable from the host",
    );
    inst.enterFrom(null);
    // Deliberately NOT a `finally`: if the resumed thread traps, the reference
    // never reaches `leave_to` either (definitions.py `Store.tick`, line 597,
    // where a Trap propagates out of `thread.resume()`), so the instance stays
    // locked — the Component Model's instance poisoning. See the `poison`
    // helper in exec/boundary.ts for the full rationale.
    //
    // Capability signals are the exception, for the same reason as there: a
    // `NeedsJspi`/`PendingCapability` marks an operation this runtime cannot
    // perform, not a component fault. In the reference that operation blocks
    // and then completes, so `leave_to` *is* reached and the instance stays
    // enterable — poisoning here would turn one unsupported operation into a
    // permanently dead instance.
    try {
      thread.resume();
    } catch (e) {
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        inst.leaveTo(null);
      }
      throw e;
    }
    inst.leaveTo(null);
    return true;
  }
}

/**
 * The reference's `canon_lift` sync driving loop (line 2213):
 *
 * ```python
 * while task.state != Task.State.RESOLVED:
 *   candidates = { t for t in inst.threads if t.ready() and t is not inst.exclusive_thread }
 *   trap_if(not candidates)
 *   random.choice(list(candidates)).resume()
 * ```
 *
 * Note the candidate set is `inst.threads` — threads *of the callee instance*
 * — and excludes the exclusive thread, and that an empty set is a **trap**
 * (the spec's deadlock trap), not a hang.
 */
export function driveSyncLift(
  task: { state: string; inst: { threads: Iterable<SchedulableThread>; exclusiveThread: unknown } },
): void {
  while (task.state !== "resolved") {
    const candidates = [...task.inst.threads].filter(
      (t) => t.ready() && (t as unknown) !== task.inst.exclusiveThread,
    );
    trapIf(
      candidates.length === 0,
      "deadlock: synchronous task cannot resolve and no thread is ready",
    );
    chooseCandidate(candidates).resume();
  }
}
