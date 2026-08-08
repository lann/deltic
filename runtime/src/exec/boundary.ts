// Host-boundary wiring: lifted-export invocation (reference `canon_lift`,
// sync path) and lowered-import bodies (reference `canon_lower`, sync path),
// built on the cabi v1 interpreter (runtime/src/cabi/) driven by the plan's
// canonical options — PLAN.md §4.3 items 2 and 5, degenerate sync case.

import {
  type CanonicalOptions,
  coreFuncTypeEquals,
  CoreValueIter,
  type ComponentValue,
  type CoreFuncType,
  type CoreType,
  type CoreValue,
  type FuncType,
  flattenFunctype,
  liftFlatValues,
  LiftLowerContext,
  lowerFlatValues,
  MAX_FLAT_ASYNC_PARAMS,
  MAX_FLAT_PARAMS,
  MAX_FLAT_RESULTS,
  type MemInst,
  type PtrType,
  trap,
  trapIf,
} from "../cabi/mod.ts";
import { AssertionError, assert_ } from "../cabi/trap.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  driveSyncLift,
  clearResumingThread,
  EventCode,
  withActivation,
  hasResumingThread,
  type EventTuple,
  NeedsJspi,
  needsJspi,
  setResumingThread,
  packSubtaskResult,
  PendingCapability,
  Store,
  Subtask,
  WaitableSet,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
} from "../task/mod.ts";
import { PlanError } from "../plan/loader.ts";
import { enterWasm, type SuspensionMode } from "../jspi/mod.ts";

/**
 * Structural view of an intrinsics `SyncCallScope`: everything this module
 * needs in order to unwind a FACT sync-call bracket a trap escaped.
 */
export interface LenderScope {
  releaseLenders(): void;
}

/** A raw core function as exposed through the JS WebAssembly API. */
// deno-lint-ignore no-explicit-any
export type CoreFn = (...args: any[]) => unknown;

/** Counters exposed for tests/diagnostics on the component handle. */
export interface ExecutionStats {
  liftedCalls: number;
  tasksResolved: number;
  postReturnsRun: number;
  loweredCalls: number;
  enterSyncCalls: number;
  exitSyncCalls: number;
  /** Callback-export invocations of the async lift loop (`canon_lift`). */
  callbackInvocations: number;
}

export function newStats(): ExecutionStats {
  return {
    liftedCalls: 0,
    tasksResolved: 0,
    postReturnsRun: 0,
    loweredCalls: 0,
    enterSyncCalls: 0,
    exitSyncCalls: 0,
    callbackInvocations: 0,
  };
}

/**
 * A `MemInst`-shaped view over a `WebAssembly.Memory` that never goes stale:
 * `bytes`/`view` re-derive from `memory.buffer` whenever the buffer identity
 * changes (memory.grow detaches the previous ArrayBuffer — a cached
 * Uint8Array would silently drop writes). The provider indirection also
 * covers plan-order effects: canonical options can reference a memory whose
 * `extract-memory` initializer runs later; accesses before extraction fail
 * with a PlanError.
 *
 * Structurally compatible with cabi's `MemInst` (same public surface).
 */
export class LiveMemory {
  readonly addrType: PtrType = "i32"; // memory64 components: out of M0 scope
  #provider: () => WebAssembly.Memory | undefined;
  #label: string;
  #buffer: ArrayBufferLike | null = null;
  #bytes: Uint8Array = new Uint8Array(0);
  #view: DataView = new DataView(new ArrayBuffer(0));

  constructor(provider: () => WebAssembly.Memory | undefined, label: string) {
    this.#provider = provider;
    this.#label = label;
  }

  #memory(): WebAssembly.Memory {
    const m = this.#provider();
    if (m === undefined) {
      throw new PlanError(
        `${this.#label} accessed before its extract-memory initializer ran`,
      );
    }
    return m;
  }

  #refresh(): void {
    const buffer = this.#memory().buffer;
    if (buffer !== this.#buffer) {
      this.#buffer = buffer;
      this.#bytes = new Uint8Array(buffer);
      this.#view = new DataView(buffer);
    }
  }

  get bytes(): Uint8Array {
    this.#refresh();
    return this.#bytes;
  }

  get view(): DataView {
    this.#refresh();
    return this.#view;
  }

  get length(): number {
    return this.#memory().buffer.byteLength;
  }

  ptrType(): PtrType {
    return this.addrType;
  }

  ptrSize(): 4 | 8 {
    return 4;
  }
}

// Compile-time proof that LiveMemory satisfies the MemInst surface.
const _memInstCheck: MemInst = new LiveMemory(() => undefined, "check");
void _memInstCheck;

/**
 * Canonical options resolved against executor state. `memory` is a
 * LiveMemory (or null); `realloc`/`postReturn`/`callback` resolve lazily so
 * options can be constructed before the corresponding extract initializers
 * run (wasmtime semantics: options hold indices, resolved at use).
 */
export interface ResolvedOptions {
  stringEncoding: "utf8" | "utf16" | "latin1+utf16";
  memory: LiveMemory | null;
  realloc: (() => CoreFn | undefined) | null;
  postReturn: (() => CoreFn | undefined) | null;
  callback: (() => CoreFn | undefined) | null;
  async: boolean;
  /**
   * `CanonicalOptions.cancellable` (wasmtime-environ 47.0.3
   * `component/info.rs:540`), i.e. whether a built-in reached through these
   * options is a *cancellable* block point.
   *
   * It lives in the options, not in the trampoline: `Trampoline::
   * WaitableSetWait`/`WaitableSetPoll` carry only `{instance, options}`
   * (info.rs:815-831). definitions.py takes it as the first parameter of
   * `canon_waitable_set_wait` / `canon_waitable_set_poll` (lines 2421/2438),
   * which is the same information arriving by a different route.
   *
   * (`thread.yield` and `subtask.cancel` are the exceptions: wasmtime puts
   * their `cancellable` / `async` flags on the *trampoline*, and those
   * built-ins read them from the decl.)
   */
  cancellable: boolean;
  coreType: CoreFuncType;
  instance: ComponentInstanceState;
}

function require<T>(
  resolver: (() => T | undefined) | null,
  what: string,
): T | null {
  if (resolver === null) return null;
  const v = resolver();
  if (v === undefined) {
    throw new PlanError(`${what} accessed before its extract initializer ran`);
  }
  return v;
}

/** cabi-facing options object (LiftLowerOptions + flatten inputs). */
export function cabiOptions(opts: ResolvedOptions): CanonicalOptions {
  return {
    stringEncoding: opts.stringEncoding,
    memory: opts.memory,
    realloc: opts.realloc === null ? null : (o, os, a, n) => {
      const realloc = require(opts.realloc, "realloc")!;
      const p = callCore(realloc, [o, os, a, n]);
      trapIf(p.length !== 1 || typeof p[0] !== "number", "realloc result");
      return (p[0] as number) >>> 0;
    },
    postReturn: null, // post-return handled by the task layer, not cabi
    async_: opts.async,
    // Truthiness only: `flattenFunctype` branches on whether a callback
    // exists (async lifts with a callback return a packed i32; stackful ones
    // return nothing). Passing the resolver rather than `null` is what makes
    // the callback-ABI core type come out right.
    callback: opts.callback === null ? null : opts.callback,
  };
}

/**
 * Call a core function, mapping core-wasm exceptions to canonical-ABI traps
 * (reference `call_and_trap_on_throw`). Component traps and internal errors
 * of ours propagate unchanged.
 */
/**
 * V8's core-wasm trap messages, mapped to the text wasmtime's `impl Display
 * for Trap` produces. The official suite's `assert_trap` compares against
 * wasmtime's wording (e.g. `builtin-trap-poisons-instance.wast:9` expects
 * ``wasm trap: wasm `unreachable` instruction executed``), so a JS host has to
 * translate — the underlying condition is identical, only the phrasing is
 * engine-specific.
 *
 * Deliberately partial: an unrecognised message falls through to the generic
 * `guest trapped: <text>` form rather than being guessed at, so a new or
 * engine-specific trap can never be silently reported as the wrong wasmtime
 * trap. (The FACT *adapter* traps take a different route entirely — they
 * arrive as numeric codes through the `trap` trampoline, see
 * `FACT_TRAP_MESSAGES` in intrinsics/mod.ts.)
 */
const CORE_TRAP_MESSAGES: Record<string, string> = {
  "unreachable": "wasm `unreachable` instruction executed",
  "memory access out of bounds": "out of bounds memory access",
  "table index is out of bounds": "undefined element: out of bounds table access",
  "null function": "uninitialized element",
  "null function or function signature mismatch": "uninitialized element",
  "function signature mismatch": "indirect call type mismatch",
  "divide by zero": "integer divide by zero",
  "divide result unrepresentable": "integer overflow",
  "float unrepresentable in integer range": "invalid conversion to integer",
  "call stack exhausted": "call stack exhausted",
  "Maximum call stack size exceeded": "call stack exhausted",
};

export function callCore(fn: CoreFn, args: CoreValue[]): CoreValue[] {
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      const mapped = CORE_TRAP_MESSAGES[e.message];
      trap(
        mapped === undefined
          ? `guest trapped: ${e.message}`
          : `wasm trap: ${mapped}`,
      );
    }
    throw e;
  }
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw as CoreValue[];
  return [raw as CoreValue];
}

/**
 * Normalize raw JS-API core values to cabi's canonical lane representation:
 * i32 lanes as unsigned numbers (the JS API yields signed), i64 lanes as
 * unsigned bigints, floats as numbers.
 */
export function normalizeCoreValues(
  values: CoreValue[],
  lanes: CoreType[],
  what: string,
): CoreValue[] {
  if (values.length !== lanes.length) {
    throw new AssertionError(
      `${what}: expected ${lanes.length} core values, got ${values.length}`,
    );
  }
  return values.map((v, i) => {
    switch (lanes[i]) {
      case "i32":
        assert_(typeof v === "number", `${what}[${i}]: i32 lane`);
        return (v as number) >>> 0;
      case "i64":
        assert_(typeof v === "bigint", `${what}[${i}]: i64 lane`);
        return BigInt.asUintN(64, v as bigint);
      case "f32":
      case "f64":
        assert_(typeof v === "number", `${what}[${i}]: float lane`);
        return v;
    }
  });
}

/** Map a resolved result list to the host-facing return value by arity. */
function resultsToHost(results: ComponentValue[]): unknown {
  if (results.length === 0) return undefined;
  if (results.length === 1) return results[0];
  return results;
}

// ---------------------------------------------------------------------------
// Driving the scheduler from the host boundary
// ---------------------------------------------------------------------------
//
// run_tests.py's `lift_and_run` (line 55) is the reference embedding:
//
//   ```python
//   func_inst = inst.store.lift(callee, ft, opts, inst)
//   _ = inst.store.invoke(func_inst, on_start, on_resolve)
//   while inst.store.waiting:
//     inst.store.tick()
//   ```
//
// i.e. enter the component, then pump the store until nothing is waiting.
// `drive` below is that loop, with two additions the reference does not need:
//
//   1. **A deadlock verdict.** The reference's `while store.waiting` spins
//      forever if no waiting thread is ready, because its host functions run
//      on real OS threads and always eventually make progress. Ours cannot
//      spin: when no thread is ready and no host promise is outstanding, the
//      task can never resolve, which is the same condition `canon_lift`'s
//      sync loop traps on (`trap_if(not candidates)`), so we trap too.
//
//   2. **Host promises.** A host import implemented as an `async` JS function
//      resolves its subtask on a *microtask turn*, not on a thread. When the
//      only way forward is such a promise, `drive` returns a Promise and the
//      lifted export's return value becomes a Promise. This needs no JSPI:
//      the guest is stackless (callback ABI), so nothing is suspended mid-wasm
//      — the guest already returned WAIT and the host merely resumes it later.
//
// Consequence for callers: a lifted export returns `T` when the whole call
// completed synchronously, and `Promise<T>` when a host promise was involved.
// The conformance harness invokes exports synchronously
// (harness/src/runtime-executor.ts) and the official suite has no
// promise-returning host imports, so it only ever sees the synchronous shape.

/** True for thenables, which is what "is this host call asynchronous" means. */
function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}


// ---------------------------------------------------------------------------
// Handshake probe (M2 phase 3l)
// ---------------------------------------------------------------------------
//
// Env-gated tracing of the drive loops. This exists because site 1 is the
// first *lit* suspension site, so the `SuspensionPoint` <-> `Store.tick` <->
// `driveAsync` handshake had never executed before it; a pure-microtask stall
// there is invisible from the outside (no trap, no rejection -- just an await
// nothing settles). Off unless CE_DRIVE_TRACE is set, and the getter is read
// once at module load so normal runs pay a boolean test.
const DRIVE_TRACE = (() => {
  try {
    return Deno.env.get("CE_DRIVE_TRACE") === "1";
  } catch {
    return false;
  }
})();
let traceTurn = 0;

function describeWaiter(t: unknown): string {
  const w = t as {
    readyFunc?: unknown;
    ready?: () => boolean;
    waiting?: () => boolean;
    constructor?: { name?: string };
  };
  const kind = w?.constructor?.name ?? "?";
  let verdict = "?";
  try {
    verdict = w.ready?.() ? "READY" : (w.readyFunc === null ? "explicit" : "not-ready");
  } catch (e) {
    verdict = `threw:${e}`;
  }
  return `${kind}[${verdict}]`;
}

function traceDrive(loop: string, store: Store, done: () => boolean, branch: string): void {
  if (!DRIVE_TRACE) return;
  let doneVerdict = "?";
  try {
    doneVerdict = String(done());
  } catch (e) {
    doneVerdict = `threw:${e}`;
  }
  const waiters = store.waiting.map(describeWaiter).join(",");
  const awaiters = [...store.awaiting].map((t) => {
    const a = t as { constructor?: { name?: string }; task?: { label?: string } };
    return `${a?.constructor?.name ?? "?"}`;
  }).join(",");
  console.error(
    `[drive #${traceTurn++}] ${loop} branch=${branch} ` +
      `ready=${store.readyCandidates().length} ` +
      `waiting=${store.waiting.length}{${waiters}} ` +
      `awaiting=${store.awaiting.size} ` +
      `hostCalls=${store.pendingHostCalls.size} ` +
      `awaiters={${awaiters}} claim=${hasResumingThread()} done=${doneVerdict}`,
  );
}

/**
 * Pump `store` until `done()` holds. Returns `undefined` if that was achieved
 * synchronously, or a Promise that settles when it has been.
 */
function drive(
  store: Store,
  done: () => boolean,
  what: string,
): void | Promise<void> {
  for (;;) {
    traceDrive("drive", store, done, "top");
    while (store.tick()) {
      traceDrive("drive", store, done, "ticked");
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
    }
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) {
      traceDrive("drive", store, done, "EXIT-done");
      return;
    }
    // A thread parked on a Promise (jspi) can only progress after a microtask
    // turn, exactly like an outstanding host call. So can an outstanding
    // ambient claim: a suspension has been settled and its activation has not
    // run yet (see `Store.tick`).
    if (store.awaiting.size > 0 || hasResumingThread()) {
      traceDrive("drive", store, done, "->async(awaiting/claim)");
      return driveAsync(store, done, what);
    }
    if (store.pendingHostCalls.size === 0) {
      traceDrive("drive", store, done, "DEADLOCK-TRAP");
      trapIf(
        true,
        `deadlock: ${what} cannot make progress (no thread is ready and no ` +
          `host call is outstanding)`,
      );
    }
    traceDrive("drive", store, done, "->async(hostcalls)");
    return driveAsync(store, done, what);
  }
}

/** A settled parked-thread promise, tagged with the thread that owns it. */
type AwaitWinner = {
  t: { awaiting: Promise<unknown> | null; resumeWith(v: unknown, f?: { error: unknown }): void };
  value: unknown;
  failure: { error: unknown } | undefined;
};

/**
 * Tagged promises, memoized by the *promise* (not the thread) so re-racing on
 * every turn does not attach a fresh continuation to the same promise, and so
 * a thread that parks again later can never pick up a stale tag.
 */
const taggedAwaits = new WeakMap<Promise<unknown>, Promise<AwaitWinner>>();

function tagAwait(t: AwaitWinner["t"]): Promise<AwaitWinner> {
  const p = t.awaiting!;
  let tag = taggedAwaits.get(p);
  if (tag === undefined) {
    tag = p.then(
      (value): AwaitWinner => ({ t, value, failure: undefined }),
      (e): AwaitWinner => ({ t, value: undefined, failure: { error: e } }),
    );
    taggedAwaits.set(p, tag);
  }
  return tag;
}

async function driveAsync(
  store: Store,
  done: () => boolean,
  what: string,
): Promise<void> {
  for (;;) {
    traceDrive("driveAsync", store, done, "top");
    // We are executing our own code again, so no engine-driven resumption is
    // in flight; drop any ambient claim before doing anything else.
    clearResumingThread();
    while (store.tick()) {
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
    }
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) {
      traceDrive("driveAsync", store, done, "EXIT-done");
      return;
    }
    // Let a settled-but-not-yet-run activation take its turn before we do
    // anything else (`Store.tick` refuses to progress while a claim is live).
    if (hasResumingThread()) {
      traceDrive("driveAsync", store, done, "yield-claim");
      await Promise.resolve();
      continue;
    }
    // Service promise-parked threads (jspi).
    //
    // This must NOT block on one chosen thread's promise. A thread parked on a
    // promising-wrapped nested activation only settles once that activation's
    // own suspension points have been resumed -- and resuming those is
    // `Store.tick`'s job, i.e. *this loop's* job. Awaiting a single promise
    // therefore stops the scheduler while waiting for something that needs the
    // scheduler: a pure-microtask stall with no trap and no rejection.
    // Observed on `async/async-calls-sync.wast` the moment site 1 became the
    // first lit suspension site (M2 phase 3l): turn N serviced a promise that
    // never settled while three other parked threads and three ready-able
    // suspension points went unexamined.
    //
    // So: race every outstanding promise (parked threads AND host calls) and
    // service whichever settles first, re-ticking each turn. The claim is
    // taken in the tagged continuation -- as close to settlement as we can get
    // -- so pin (i)'s window (engine-driven wasm resumption running built-ins
    // before our continuation) is still covered for the thread that actually
    // resumed, without falsely claiming the ambient for threads that did not.
    if (store.awaiting.size > 0) {
      // Claim the ambient for ONE parked thread and await its promise -- as
      // before, so pin (i)'s window is covered exactly as it was -- but race
      // that promise against every other outstanding promise so this loop can
      // never be held hostage by it. The claimed thread's promise may only be
      // settleable by further scheduler progress (a promising-wrapped nested
      // activation whose own suspension points this loop must still resume);
      // blocking on it alone is the pure-microtask stall of M2 phase 3l.
      const parked = [...store.awaiting] as AwaitWinner["t"][];
      const chosen = parked[0];
      const chosenTag = tagAwait(chosen);
      const others: Promise<AwaitWinner | null>[] = parked.slice(1).map(tagAwait);
      for (const h of store.pendingHostCalls) {
        others.push(h.then(() => null, () => null));
      }
      setResumingThread(chosen);
      let winner: AwaitWinner | null;
      try {
        winner = await Promise.race([chosenTag, ...others]);
      } finally {
        clearResumingThread();
      }
      // Resume whichever thread actually settled -- not necessarily the one we
      // claimed. Resuming only the claimed thread would spin: its promise may
      // never settle, the same thread would be chosen again next turn, and the
      // already-settled tags would win the race instantly forever (observed as
      // an OOM, not a hang). The claim is cleared above before any resumption,
      // exactly as on the original single-promise path, so this does not widen
      // the ambient window; it only ensures the loop always makes progress.
      if (winner !== null && store.awaiting.has(winner.t)) {
        winner.t.resumeWith(winner.value, winner.failure);
      }
      continue;
    }
    if (store.pendingHostCalls.size === 0) {
      traceDrive("driveAsync", store, done, "DEADLOCK-TRAP");
      trapIf(
        true,
        `deadlock: ${what} cannot make progress (no thread is ready and no ` +
          `host call is outstanding)`,
      );
    }
    traceDrive("driveAsync", store, done, "await-race");
    // Settlement order among several outstanding host calls is the host's,
    // not ours — this is genuine, unavoidable nondeterminism at the boundary
    // (the reference has the same freedom in `Store.tick`). Everything
    // *inside* the component stays deterministic per scheduler.ts.
    await Promise.race([...store.pendingHostCalls]).catch(() => {});
  }
}

function takeHostFailure(store: Store): unknown {
  const e = store.hostFailure;
  store.hostFailure = undefined;
  return e;
}

// ---------------------------------------------------------------------------
// canon lift
// ---------------------------------------------------------------------------

/**
 * Build the host-callable function for one lifted export (reference
 * `Store.lift` + `canon_lift`, definitions.py lines 578 and 2154).
 *
 * All three lift shapes go through one `Task` + implicit `Thread`:
 *
 *   * **sync** (`not ft.async`) — call, lift results, `task.return_`,
 *     post-return, then the sync driving loop until the task resolves;
 *   * **async + callback** (stackless) — the packed-code loop
 *     (EXIT / YIELD / WAIT), fully implemented here;
 *   * **async, no callback** (stackful) — the guest blocks mid-stack, which
 *     needs genuine wasm-frame suspension: `needsJspi`, at the precise point.
 */
export function createLiftedFunction(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  core: CoreFn;
  stats: ExecutionStats;
  /**
   * Suspension discipline for this instantiation (jspi/bridge.ts). In `jspi`
   * mode the export's core function is `promising`-wrapped, so the whole
   * activation can suspend and the lifted function necessarily returns a
   * Promise.
   */
  suspensionMode?: SuspensionMode;
  /** Optional; see intrinsics `HostTrapState`. */
  trapState?: { pending: unknown };
  /**
   * Optional; the executor's sync-call scope stack (intrinsics
   * `SyncCallScope`). Structural, to keep this module free of an import
   * cycle with `../intrinsics/`.
   */
  syncCallStack?: LenderScope[];
  /**
   * Optional; every component instance of this component, for restoring
   * `may_leave` when a trap unwinds out of a FACT adapter.
   */
  allInstances?: () => Iterable<{ mayLeave: boolean }>;
}): (...args: ComponentValue[]) => unknown {
  const {
    name,
    ft,
    opts,
    core,
    stats,
    trapState,
    syncCallStack,
    allInstances,
  } = input;
  const inst = opts.instance;
  const store = inst.store;
  const mode: SuspensionMode = input.suspensionMode ?? "plain";
  // Entry wrapping, half of jspi/bridge.ts's invariant: a lifted export's core
  // function is one of the three activations that can reach a blocking
  // built-in, so it is `promising`-wrapped exactly when the imports are
  // `Suspending`-wrapped.
  const enteredCore = enterWasm(core, mode);
  const taskOpts: TaskOptions = {
    async_: opts.async,
    callback: opts.callback !== null,
    stringEncoding: opts.stringEncoding,
    memory: opts.memory,
  };

  // definitions.py `canon_lift` only ever sees consistent combinations; the
  // plan could in principle carry others, so reject at instantiate time.
  if (opts.callback !== null && !opts.async) {
    throw new PlanError(
      `export '${name}': canonical options carry a callback but are not ` +
        `async (callback is meaningless for a sync lift)`,
    );
  }

  // Instantiate-time consistency check (descriptor-ir.md "Flattening"):
  // flattening computed from the type must agree with the shim's coreType.
  const computed = flattenFunctype(cabiOptions(opts), ft, "lift");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(
      `export '${name}': computed flat type ${JSON.stringify(computed)} ` +
        `!= plan coreType ${JSON.stringify(opts.coreType)}`,
    );
  }

  return (...hostArgs: ComponentValue[]): unknown => {
    if (hostArgs.length !== ft.params.length) {
      throw new TypeError(
        `${name}: expected ${ft.params.length} argument(s), got ${hostArgs.length}`,
      );
    }
    stats.liftedCalls++;
    // A trap remembered during an earlier call must never be attributed to
    // this one (see intrinsics `HostTrapState`).
    if (trapState !== undefined) trapState.pending = undefined;
    // Depth of the sync-call scope stack on entry; see the `finally` below.
    const syncCallDepth = syncCallStack?.length ?? 0;

    // Reference `Store.lift` (line 578): the host is the caller, so the
    // entering set is the callee's `self_and_ancestors()`.
    trapIf(
      !inst.mayEnterFrom(null),
      `cannot enter component instance ${inst.index} (reentrance forbidden)`,
    );
    // The set this entry locked (definitions.py `ComponentInstance.enter_from`
    // iterates `entering_set`). Remembered so a trap can leave exactly these
    // locked and no others.
    const enteredSet = inst.enteringSet(null);
    inst.enterFrom(null);
    let entered = true;
    let completed = false;

    let resolved: ComponentValue[] | null = null;
    let resolvedSeen = false;
    const task = new Task(
      ft,
      taskOpts,
      inst,
      () => hostArgs,
      (result) => {
        resolved = result;
        resolvedSeen = true;
        stats.tasksResolved++;
      },
    );

    const thread: Thread = new Thread(
      task,
      liftBody({
        name,
        ft,
        opts,
        core: enteredCore,
        stats,
        task,
        thread: () => thread,
        mode,
      }),
    );

    const finishHostEntry = (): unknown => {
      completed = true;
      trapIf(
        !resolvedSeen,
        `${name}: task finished without resolving (deadlock)`,
      );
      if (resolved === null) {
        // definitions.py `Task.cancel`: `on_resolve(None)`. A host-initiated
        // call has no way to express "cancelled" in its return value, and the
        // host never requests cancellation, so reaching this is a bug.
        throw new AssertionError(
          `${name}: task resolved as cancelled, but the host never ` +
            `requested cancellation`,
        );
      }
      return resultsToHost(resolved);
    };

    const unwind = (): void => {
      // Unwind any FACT sync-call brackets a trap escaped.
      //
      // A trap thrown inside an adapter skips that adapter's
      // `exit-sync-call`, so its `SyncCallScope` (and the `num_lends` it
      // holds on the caller's handles) would otherwise survive the call.
      // wasmtime does not need this: it poisons the whole store on trap
      // (`Store::call_hook`/panic-on-reuse semantics), so no later call can
      // observe the stale state. This runtime deliberately supports
      // post-trap re-entry — the `trapState.pending` reset above exists for
      // exactly that — so the state has to be unwound instead. Leaving it
      // would attach the next `transfer-borrow` to a dead scope and leave
      // lent handles permanently un-droppable ("while borrowed" forever).
      if (completed) return;
      // Per-ACTIVATION now (see `Thread.syncCallStack`): unwind the brackets
      // of every activation this task owns, which a trap inside a FACT adapter
      // skipped. A task can have several threads, so the loop is over threads.
      for (const t of task.threads as { syncCallStack: unknown[] }[]) {
        while (t.syncCallStack.length > 0) {
          (t.syncCallStack.pop() as LenderScope).releaseLenders();
        }
      }
      void syncCallStack;
      void syncCallDepth;
      // FACT clears the callee's / caller's `may_leave` flag around each
      // lift and lower (`fact/trampoline.rs`, `set_may_leave_false`) and
      // restores it afterwards. A trap in between skips the restore, so an
      // instance can be left permanently unable to leave — every later call
      // through an adapter then trips FACT's own `CannotLeaveComponent`
      // check. With the stack unwound to the host boundary no lift or lower
      // is in flight, so `may_leave` is true for every instance by
      // definition; assert that resting state rather than leaving the
      // component bricked.
      //
      // The *entered* instances are excluded: they are poisoned by this trap
      // (see `poison` below) and must stay exactly as the trap left them.
      // Restoring their `may_leave` would be tidying the state of an instance
      // that is no longer allowed to run at all.
      for (const i of allInstances?.() ?? []) {
        if (!enteredSet.has(i as unknown as ComponentInstanceState)) {
          i.mayLeave = true;
        }
      }
    };

    const leave = (): void => {
      if (!entered) return;
      entered = false;
      inst.leaveTo(null);
    };

    /**
     * A trap escaped the task: **do not** release the reentrance lock.
     *
     * definitions.py `Store.lift` (line 578) is
     *
     * ```python
     * trap_if(not inst.may_enter_from(caller))
     * inst.enter_from(caller)
     * on_cancel = canon_lift(...)     # <-- a Trap propagates out of here
     * inst.leave_to(caller)           # <-- and so this never runs
     * ```
     *
     * so a trapping task leaves every instance it entered with
     * `may_enter == False` permanently. That is the Component Model's
     * "poisoning": a component that trapped is not in a known state, so it may
     * never be entered again, and the next call reports `cannot enter
     * component instance`. `test/async/builtin-trap-poisons-instance.wast`
     * asserts exactly this, twice.
     *
     * Only the entered set is affected; sibling instances stay usable, which
     * is why the lock is released per-instance rather than by poisoning a
     * whole store the way wasmtime does.
     */
    const poison = (): void => {
      entered = false; // consumed: the lock is now permanent
    };

    /**
     * Is `e` a *capability* signal rather than a genuine trap?
     *
     * `NeedsJspi` and `PendingCapability` mean "this runtime is incomplete",
     * not "the component faulted". Poisoning on them is wrong on the
     * reference's own terms: the operation they stand in for — a synchronous
     * stream copy, `waitable-set.wait`, a blocking cross-component call —
     * *blocks and then completes* in definitions.py. `Store.lift` reaches
     * `leave_to` in every one of those executions, so the instance stays
     * enterable. Poisoning would attribute a permanent fault to a component
     * that, on a complete runtime, is perfectly healthy — and it cascades:
     * one unsupported operation made every later call on that instance report
     * `cannot enter component instance`, which is neither our real behaviour
     * nor the reference's.
     *
     * What unwinding must still do on this path, and what it must not:
     *
     *  - MUST release the reentrance lock (`leave`) — the call is over and no
     *    activation of this instance survives it.
     *  - MUST unwind the FACT sync-call scopes and restore `may_leave`
     *    (`unwind`), for exactly the reasons it does after a trap: a bail-out
     *    mid-adapter skips `exit-sync-call` and the `may_leave` restore, and
     *    that state is shared with sibling instances.
     *  - MUST NOT try to "finish" the abandoned operation. A stream end left
     *    in `CopyState.COPYING` with its buffer parked in the shared object is
     *    the honest record of "this copy never happened"; the counterpart has
     *    not been notified and must not be, because on a complete runtime the
     *    copy would still be pending. Likewise a `prepare-call` slot consumed
     *    by a `*-start-call` that then bailed is already cleared by
     *    `takePrepared`, so nothing leaks there.
     *  - MUST NOT resolve or cancel the task: the host call fails, and the
     *    task simply never resolved.
     *
     * In other words the instance is left exactly as a *pending* operation
     * would leave it, which is the truthful state, and the only thing the
     * embedder loses is the result of this one call.
     */
    const isCapabilitySignal = (e: unknown): boolean =>
      e instanceof NeedsJspi || e instanceof PendingCapability;

    try {
      thread.resume();
      // definitions.py `canon_lift` (line 2213): the sync driving loop runs
      // *inside* the enter/leave bracket, over the callee instance's threads.
      //
      // It is skipped in jspi mode, and must be. That loop resumes *ready*
      // threads and traps when there are none — the reference's deadlock
      // trap. A thread parked on a Promise is neither ready nor waiting: only
      // a microtask turn can advance it, which a synchronous loop cannot give.
      // Running it anyway declared a bogus deadlock the moment a sync-lifted
      // export's activation suspended, which then trap-poisoned the instance
      // and abandoned the activation mid-bracket — the orphaned
      // `exit-sync-call` traced across phases 3h-3j.
      //
      // `drive` below is the correct driver in that mode: it knows about
      // `store.awaiting`, still enforces the deadlock trap (no ready thread,
      // no pending host call, nothing awaiting), and returns a Promise, which
      // a jspi-mode lifted export returns anyway.
      if (!ft.async && mode !== "jspi") driveSyncLift(task);
    } catch (e) {
      unwind();
      if (isCapabilitySignal(e)) leave();
      else poison();
      throw e;
    }
    // The reentrance gate is released here, before the store is pumped:
    // `Store.tick` re-enters each waiting thread's instance itself
    // (`enter_from(None)` / `leave_to(None)`), exactly as in the reference,
    // where `lift_and_run` ticks after `store.invoke` has returned.
    leave();

    let pending: void | Promise<void>;
    try {
      // Completion is "the task resolved AND its threads have drained", not
      // merely "resolved". `task.return` resolves the task, but the activation
      // is not finished until its implicit thread reaches
      // `exit_implicit_thread` — for a callback task that means running the
      // loop out to EXIT, which releases `inst.exclusiveThread`.
      //
      // In plain mode the two almost always coincide, because the generator
      // runs to completion inside one `resume()`. Under JSPI they do not: the
      // guest calls `task.return` while the activation is still suspended, so
      // the old predicate let the driver return early and the thread was
      // abandoned mid-loop — leaking the exclusive thread and its table slot.
      // The lifted call is over when the task has resolved AND this task's
      // activation is no longer mid-wasm-call. Those are two different events
      // and both matter (M2 phase 3e):
      //
      //   * "task resolved" alone abandons a still-running activation. Under
      //     JSPI the guest calls `task.return` while suspended, so returning
      //     there left the callback loop parked forever — leaking the
      //     exclusive thread and its table slot.
      //   * "activation finished" alone deadlocks a *producer* guest, which
      //     legitimately keeps forwarding after `task.return`
      //     (wit-bindgen `wit_stream::new()` + a spawned loop).
      //
      // The distinguishing question is *what* the thread is parked on. An
      // `awaitValue` park means a wasm call is in flight and will settle on
      // its own, so we must keep draining. A park in `store.waiting` means the
      // activation is waiting on a scheduler condition only the embedder can
      // satisfy — that is a **background activation**: we return to the host
      // and leave the thread live, and later `drive`/`pump` calls (host stream
      // writes, the next export call) go on servicing it.
      const midWasmCall = () => task.threads.some((t) => store.awaiting.has(t));
      pending = drive(
        store,
        () => resolvedSeen && !midWasmCall(),
        `export '${name}'`,
      );
    } catch (e) {
      unwind();
      throw e;
    }
    if (pending === undefined) {
      try {
        return finishHostEntry();
      } catch (e) {
        unwind();
        throw e;
      }
    }
    return pending.then(finishHostEntry, (e) => {
      unwind();
      throw e;
    });
  };
}

/**
 * Call into wasm and hand back the result, awaiting it only if it is a
 * Promise.
 *
 * This is the whole of the jspi entry seam. In **plain** mode the entry is not
 * `promising`-wrapped, `callCore` returns core values, and this returns them
 * without yielding — no await, no Promise allocation, the identical
 * synchronous path M1 shipped. In **jspi** mode the entry *is* wrapped, so the
 * call returns a Promise (jspi pin (e)) and we park the thread on it via the
 * `awaitValue` block request; the driving loop resumes us with the values, or
 * throws the rejection in (a post-resume trap).
 */
export function* awaitCore(
  fn: CoreFn,
  args: CoreValue[],
  // deno-lint-ignore no-explicit-any
  thread: any,
): Generator<BlockRequest, CoreValue[], unknown> {
  // Enter wasm with the activation-attached ambient in scope. In jspi mode the
  // engine captures this context when it registers its resumption, so a
  // built-in called by the resumed activation can recover its thread even when
  // nobody is driving (see `withActivation`).
  const raw = withActivation(thread, () => callCore(fn, args));
  // `callCore` normalizes a bare value to a one-element array; a promising
  // entry yields `[Promise]`.
  if (raw.length === 1 && isPromiseLike(raw[0])) {
    const settled = yield {
      readyFunc: null,
      cancellable: false,
      awaitValue: Promise.resolve(raw[0] as unknown as Promise<unknown>),
    };
    if (settled === undefined) return [];
    return Array.isArray(settled) ? settled as CoreValue[] : [settled as CoreValue];
  }
  return raw;
}

/** definitions.py `CallbackCode` (line 2220). */
enum CallbackCode {
  EXIT = 0,
  YIELD = 1,
  WAIT = 2,
}
const CALLBACK_CODE_MAX = 2;

/** definitions.py `unpack_callback_result` (line 2226). */
export function unpackCallbackResult(
  packed: number,
): [code: CallbackCode, waitableSetIndex: number] {
  const code = packed & 0xf;
  trapIf(code > CALLBACK_CODE_MAX, `invalid callback code ${code}`);
  return [code as CallbackCode, packed >>> 4];
}

/**
 * The body of `canon_lift`'s implicit thread (definitions.py line 2155),
 * as a generator so its block points are real suspension points of the
 * host-side thread model (see task/scheduler.ts).
 */
function* liftBody(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  core: CoreFn;
  stats: ExecutionStats;
  task: Task;
  thread: () => Thread;
  mode: SuspensionMode;
}): Generator<BlockRequest, void, Cancelled> {
  const { name, ft, opts, core, stats, task } = input;
  const thread = input.thread();
  const inst = opts.instance;

  if (!(yield* task.enterImplicitThread(thread))) return;

  const cx = new LiftLowerContext(cabiOptions(opts), inst, task);
  const args = task.start();
  const flatArgs = lowerFlatValues(cx, MAX_FLAT_PARAMS, args, ft.params);

  if (!opts.async) {
    const flatResults = normalizeCoreValues(
      yield* awaitCore(core, flatArgs, thread),
      opts.coreType.results,
      `${name} results`,
    );
    const results = liftFlatValues(
      cx,
      MAX_FLAT_RESULTS,
      new CoreValueIter(flatResults),
      ft.results,
    );
    task.return_(results);
    // Post-return runs after the results were read out of guest memory,
    // with may_leave cleared (reference canon_lift).
    const postReturn = require(opts.postReturn, `${name} post-return`);
    if (postReturn !== null) {
      assert_(inst.mayLeave, "post-return with may_leave already false");
      inst.mayLeave = false;
      callCore(postReturn, flatResults);
      inst.mayLeave = true;
      stats.postReturnsRun++;
    }
    task.exitImplicitThread(thread);
    return;
  }

  if (opts.callback === null) {
    // definitions.py line 2179: `[] = call_and_trap_on_throw(callee, flat_args)`
    // — the guest keeps running on its own stack and blocks inside wasm at
    // whatever built-in it chooses. There is no return-to-host between the
    // call and the block, so the only way to model it is genuine wasm-frame
    // suspension.
    //
    // In jspi mode that is exactly what happens and no special handling is
    // needed: the entry is `promising`-wrapped, so the activation suspends on
    // whichever blocking built-in it reaches and `awaitCore` parks this thread
    // until it finishes. Results arrive through `task.return`, so there is
    // nothing to lift here.
    if (input.mode !== "jspi") {
      needsJspi(
        `stackful async lift of export '${name}' (async canonical options ` +
          `without a callback)`,
      );
    }
    yield* awaitCore(core, flatArgs, thread);
    task.exitImplicitThread(thread);
    return;
  }

  // --- callback ABI (definitions.py lines 2183-2214) ----------------------
  //
  // Stackless by construction: every wasm activation *returns* a packed code,
  // and all waiting happens on the host side between activations. This is the
  // path wit-bindgen 0.60 emits for every async export, and it needs no JSPI.
  // The callback export is the second of the three entries that can reach a
  // blocking built-in (jspi/bridge.ts's invariant), so it is wrapped exactly
  // like the lifted core. Leaving it plain while the core was promising was a
  // *mixed* activation, which pin (c) punishes: the first Suspending import
  // it reached would trap.
  const callback = enterWasm(
    require(opts.callback, `${name} callback`)!,
    input.mode,
  );
  const [packed] = normalizeCoreValues(
    yield* awaitCore(core, flatArgs, thread),
    opts.coreType.results,
    `${name} results`,
  ) as [number];
  yield* runCallbackLoop({ name, task, thread, inst, callback, packed, stats });
  task.exitImplicitThread(thread);
}

// ---------------------------------------------------------------------------
// canon lower
// ---------------------------------------------------------------------------

/**
 * Build the core-callable body for one lowered host import (reference
 * `canon_lower`, definitions.py line 2242).
 *
 * Sync and async lowers share one `Subtask` and one pair of
 * `on_start`/`on_resolve` closures, exactly as the reference does; the sync
 * case is the degenerate one where the callee resolves before returning.
 *
 * The host callee is a plain JS function. If it returns a **Promise**, the
 * subtask resolves when that promise settles:
 *
 *   * async lower — fully supported and JSPI-free. The guest gets a STARTED
 *     subtask back, joins it to a waitable set, returns WAIT from its
 *     callback, and the scheduler delivers the SUBTASK event once the promise
 *     settles. This is the flagship capability of this phase: an ordinary
 *     `async` JS function is a valid Component Model async import.
 *   * sync lower — the guest's wasm frame would have to block
 *     (`thread.wait_until(subtask.resolved)`, line 2286), so: `needsJspi`.
 */
export function createLoweredImport(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  hostFn: (...args: unknown[]) => unknown;
  stats: ExecutionStats;
}): CoreFn {
  const { name, ft, opts, hostFn, stats } = input;
  const inst = opts.instance;
  const store = inst.store;

  const computed = flattenFunctype(cabiOptions(opts), ft, "lower");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(
      `import '${name}': computed flat type ${JSON.stringify(computed)} ` +
        `!= plan coreType ${JSON.stringify(opts.coreType)}`,
    );
  }

  // definitions.py lines 2250-2256.
  const maxFlatParams = opts.async ? MAX_FLAT_ASYNC_PARAMS : MAX_FLAT_PARAMS;
  const maxFlatResults = opts.async ? 0 : MAX_FLAT_RESULTS;

  return (...rawFlatArgs: CoreValue[]): unknown => {
    stats.loweredCalls++;
    // Reference canon_lower: trap_if(!inst.may_leave).
    trapIf(
      !inst.mayLeave,
      `cannot leave component instance ${inst.index} (may_leave violation)`,
    );
    const subtask = new Subtask();
    const cx = new LiftLowerContext(cabiOptions(opts), inst, subtask);
    const vi = new CoreValueIter(
      normalizeCoreValues(rawFlatArgs, opts.coreType.params, `${name} args`),
    );

    /**
     * definitions.py's `maybe_on_progress`: a no-op until the subtask has been
     * given a handle index, then the pending-event setter. Assigning it only
     * after the callee returned unresolved is deliberate in the reference —
     * an eagerly-resolving callee must never produce an event.
     */
    let onProgress: () => void = () => {};

    const onStart = (): ComponentValue[] => {
      onProgress();
      assert_(
        subtask.state === SubtaskState.STARTING,
        `${name}: on_start on a started subtask`,
      );
      subtask.state = SubtaskState.STARTED;
      return liftFlatValues(cx, maxFlatParams, vi, ft.params);
    };

    const onResolve = (result: ComponentValue[] | null): void => {
      onProgress();
      if (result === null) {
        assert_(
          subtask.cancellationRequested,
          `${name}: resolved as cancelled without a cancellation request`,
        );
        subtask.resolve(
          subtask.state === SubtaskState.STARTING
            ? SubtaskState.CANCELLED_BEFORE_STARTED
            : SubtaskState.CANCELLED_BEFORE_RETURNED,
          [],
        );
        return;
      }
      assert_(
        subtask.state === SubtaskState.STARTED,
        `${name}: on_resolve on a subtask that never started`,
      );
      // Spilled results use the trailing retptr lane(s) of the flat args
      // (reference passes the same iterator as out_param).
      const flatResults = lowerFlatValues(
        cx,
        maxFlatResults,
        result,
        ft.results,
        vi,
      );
      subtask.resolve(SubtaskState.RETURNED, flatResults);
    };

    // --- invoke the host callee (the reference's `callee(...)`, line 2283) --
    //
    // definitions.py assigns the callee's `OnCancel` here:
    //   `subtask.on_cancel = callee(on_start, on_resolve, caller = ...)`
    //
    // A host import is a plain JS function and offers no cancellation
    // channel — there is nothing to forward a request to. The faithful model
    // is therefore a handler that *accepts and ignores* the request, which is
    // exactly what the reference permits: `canon_subtask_cancel` (line 2476)
    // calls `on_cancel` and then re-checks `subtask.resolved()`; a callee that
    // declines to cancel promptly leaves the subtask unresolved, and the async
    // form returns BLOCKED while the sync form waits. The subtask still
    // resolves normally when the promise settles — cancellation is a request,
    // not a guarantee.
    //
    // Leaving `on_cancel` null instead made a *legal* `subtask.cancel` crash
    // with an internal AssertionError, which is neither reference behaviour
    // nor a sanctioned incompleteness signal.
    subtask.onCancel = () => {};
    const args = onStart();
    const raw = hostFn(...args);
    const toResults = (v: unknown): ComponentValue[] =>
      ft.results.length === 0 ? [] : [v as ComponentValue];

    if (isPromiseLike(raw)) {
      if (!opts.async) {
        // definitions.py line 2286: `thread.wait_until(subtask.resolved)` —
        // blocking the calling *wasm frame*.
        needsJspi(
          `synchronous lower of import '${name}', whose host implementation ` +
            `returned a Promise (the guest's wasm frame must block)`,
        );
      }
      const promise = Promise.resolve(raw).then(
        (v) => {
          store.pendingHostCalls.delete(promise);
          try {
            onResolve(toResults(v));
          } catch (e) {
            store.hostFailure = e;
          }
        },
        (e) => {
          store.pendingHostCalls.delete(promise);
          store.hostFailure = e;
        },
      );
      store.pendingHostCalls.add(promise);
    } else {
      onResolve(toResults(raw));
    }

    // definitions.py line 2284: a sync-*typed* callee must have resolved.
    assert_(
      ft.async || subtask.resolved(),
      `${name}: a non-async-typed import must resolve before returning`,
    );

    if (!opts.async) {
      if (!subtask.resolved()) {
        needsJspi(
          `synchronous lower of import '${name}' on an unresolved subtask`,
        );
      }
      subtask.deliverResolve();
      assert_(vi.done(), `${name}: unconsumed flat arguments`);
      const flatResults = subtask.flatResults;
      if (flatResults.length === 0) return undefined;
      if (flatResults.length === 1) return flatResults[0];
      return flatResults;
    }

    // --- async lower (definitions.py lines 2289-2309) ----------------------
    if (subtask.resolved()) {
      // Eager-resolve fast path: no handle, no event, no waitable — the guest
      // learns the call is done from the return value alone.
      subtask.deliverResolve();
      assert_(
        subtask.flatResults.length === 0,
        `${name}: async lower produced flat results`,
      );
      return SubtaskState.RETURNED;
    }
    const subtaski = inst.handles.add(subtask);
    onProgress = () => subtask.setSubtaskPendingEvent(subtaski);
    return packSubtaskResult(subtask.state, subtaski);
  };
}


/**
 * The callback-ABI dispatch loop of `canon_lift` (definitions.py lines
 * 2183-2214), factored out so both entry points share one implementation:
 *
 *   * a host-boundary lift (`liftBody` above), and
 *   * a FACT cross-component call, where the host invokes an async-lifted
 *     callee on the caller's behalf (`intrinsics/fact_calls.ts`).
 *
 * `packed` is the code the *initial* activation returned; the loop runs until
 * it sees EXIT, invoking the callback export with each delivered event.
 */
export function* runCallbackLoop(input: {
  name: string;
  task: Task;
  thread: Thread;
  inst: ComponentInstanceState;
  callback: CoreFn;
  packed: number;
  stats: ExecutionStats;
}): Generator<BlockRequest, void, Cancelled> {
  const { name, task, thread, inst, callback, stats } = input;
  let [code, si] = unpackCallbackResult(input.packed);

  while (code !== CallbackCode.EXIT) {
    assert_(
      task.needsExclusive() && inst.exclusiveThread === task.implicitThread,
      "callback loop without holding the exclusive thread",
    );
    // Releasing the exclusive thread across the wait is what lets *another*
    // task of the same instance enter and run while this one waits — the
    // whole point of the callback ABI (definitions.py line 2186).
    inst.exclusiveThread = null;
    let event: EventTuple;
    switch (code) {
      case CallbackCode.YIELD: {
        const cancelled = yield* thread.waitUntil(
          () => inst.exclusiveThread === null,
          true,
        );
        event = cancelled
          ? [EventCode.TASK_CANCELLED, 0, 0]
          : [EventCode.NONE, 0, 0];
        break;
      }
      case CallbackCode.WAIT: {
        const wset = inst.handles.get(si);
        trapIf(
          !(wset instanceof WaitableSet),
          `callback returned WAIT with index ${si}, which is not a waitable set`,
        );
        event = yield* (wset as WaitableSet).waitForEventAnd(
          thread,
          () => inst.exclusiveThread === null,
          true,
        );
        break;
      }
      default:
        trap(`invalid callback code ${code}`);
    }
    assert_(
      inst.exclusiveThread === null,
      "exclusive thread taken while this task was waiting",
    );
    inst.exclusiveThread = task.implicitThread;
    stats.callbackInvocations++;
    const [next] = normalizeCoreValues(
      yield* awaitCore(callback, [event[0], event[1], event[2]], thread),
      ["i32"],
      `${name} callback result`,
    ) as [number];
    [code, si] = unpackCallbackResult(next);
  }
}
