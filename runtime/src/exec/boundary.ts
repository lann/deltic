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
  EventCode,
  needsJspi,
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
export function callCore(fn: CoreFn, args: CoreValue[]): CoreValue[] {
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      trap(`guest trapped: ${e.message}`);
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
    while (store.tick()) {
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
    }
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) return;
    if (store.pendingHostCalls.size === 0) {
      trapIf(
        true,
        `deadlock: ${what} cannot make progress (no thread is ready and no ` +
          `host call is outstanding)`,
      );
    }
    return driveAsync(store, done, what);
  }
}

async function driveAsync(
  store: Store,
  done: () => boolean,
  what: string,
): Promise<void> {
  for (;;) {
    while (store.tick()) {
      if (store.hostFailure !== undefined) throw takeHostFailure(store);
    }
    if (store.hostFailure !== undefined) throw takeHostFailure(store);
    if (done()) return;
    if (store.pendingHostCalls.size === 0) {
      trapIf(
        true,
        `deadlock: ${what} cannot make progress (no thread is ready and no ` +
          `host call is outstanding)`,
      );
    }
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
      liftBody({ name, ft, opts, core, stats, task, thread: () => thread }),
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
      if (syncCallStack !== undefined) {
        while (syncCallStack.length > syncCallDepth) {
          syncCallStack.pop()!.releaseLenders();
        }
      }
      // FACT clears the callee's / caller's `may_leave` flag around each
      // lift and lower (`fact/trampoline.rs`, `set_may_leave_false`) and
      // restores it afterwards. A trap in between skips the restore, so an
      // instance can be left permanently unable to leave — every later call
      // through an adapter then trips FACT's own `CannotLeaveComponent`
      // check. With the stack unwound to the host boundary no lift or lower
      // is in flight, so `may_leave` is true for every instance by
      // definition; assert that resting state rather than leaving the
      // component bricked.
      for (const i of allInstances?.() ?? []) i.mayLeave = true;
    };

    const leave = (): void => {
      if (!entered) return;
      entered = false;
      inst.leaveTo(null);
    };

    try {
      thread.resume();
      // definitions.py `canon_lift` (line 2213): the sync driving loop runs
      // *inside* the enter/leave bracket, over the callee instance's threads.
      if (!ft.async) driveSyncLift(task);
    } catch (e) {
      unwind();
      leave();
      throw e;
    }
    // The reentrance gate is released here, before the store is pumped:
    // `Store.tick` re-enters each waiting thread's instance itself
    // (`enter_from(None)` / `leave_to(None)`), exactly as in the reference,
    // where `lift_and_run` ticks after `store.invoke` has returned.
    leave();

    let pending: void | Promise<void>;
    try {
      pending = drive(store, () => resolvedSeen, `export '${name}'`);
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
      callCore(core, flatArgs),
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
    needsJspi(
      `stackful async lift of export '${name}' (async canonical options ` +
        `without a callback)`,
    );
  }

  // --- callback ABI (definitions.py lines 2183-2214) ----------------------
  //
  // Stackless by construction: every wasm activation *returns* a packed code,
  // and all waiting happens on the host side between activations. This is the
  // path wit-bindgen 0.60 emits for every async export, and it needs no JSPI.
  const callback = require(opts.callback, `${name} callback`)!;
  let [packed] = normalizeCoreValues(
    callCore(core, flatArgs),
    opts.coreType.results,
    `${name} results`,
  ) as [number];
  let [code, si] = unpackCallbackResult(packed);

  while (code !== CallbackCode.EXIT) {
    assert_(
      task.needsExclusive() && inst.exclusiveThread === task.implicitThread,
      "callback loop without holding the exclusive thread",
    );
    // Releasing the exclusive thread across the wait is what lets *another*
    // task of the same instance enter and run while this one waits — the
    // whole point of the callback ABI (definitions.py line 2186).
    inst.exclusiveThread = null;
    let event: import("../task/mod.ts").EventTuple;
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
    [packed] = normalizeCoreValues(
      callCore(callback, [event[0], event[1], event[2]]),
      ["i32"],
      `${name} callback result`,
    ) as [number];
    [code, si] = unpackCallbackResult(packed);
  }
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
