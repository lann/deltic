// FACT cross-component call intrinsics: `prepare-call`, `sync-start-call` and
// `async-start-call` (contracts/intrinsics.md §A).
//
// These are how one component calls another's *async-lifted* export, or how an
// async-lowered import reaches any export. They have no direct analogue in
// definitions.py, because the reference has no fused adapters: there,
// `canon_lower` calls the callee's `FuncInst` directly and the host performs
// every copy. wasmtime instead compiles a FACT adapter that hoists the copying
// into wasm and asks the host to do only the task bookkeeping. The *semantics*
// are the reference's; only the division of labour differs.
//
// ===========================================================================
// THE PROTOCOL (wasmtime-environ 47.0.3)
// ===========================================================================
//
// Emission sites: `fact/trampoline.rs` — `call_prepare` (line 513),
// `compile_async_to_async_adapter` (474), `compile_sync_to_async_adapter`
// (607), `compile_async_to_sync_adapter` (643). Signatures: `fact.rs`
// `import_prepare_call` (584), `import_sync_start_call` (620),
// `import_async_start_call` (643), with `PREPARE_CALL_FIXED_PARAMS` at
// `fact.rs:47`.
//
//   prepare-call(start: funcref, return: funcref,
//                caller_instance: i32, callee_instance: i32,
//                task_return_type: i32, callee_async: i32,
//                string_encoding: i32, result_count_or_max_if_async: i32,
//                ...caller's own flat params) -> ()
//
//   sync-start-call (callee: funcref, lift_param_count: i32)
//                       -> the caller's flat results
//   async-start-call(callee: funcref, param_count: i32,
//                    result_count: i32, flags: i32) -> i32   (packed subtask)
//
// **The `start` / `return` funcrefs are the reference's `on_start` /
// `on_resolve`.** That is the load-bearing finding, and their signatures
// (`fact/signature.rs`) say so exactly:
//
//   `[async-start]` (async_start_signature, line 61)
//       params  = the *caller's* flattened params  (what prepare-call stashed)
//       results = the *callee's* flattened params  (hand straight to the callee)
//     i.e. "given the caller's arguments, produce the callee's" — `on_start`.
//
//   `[async-return]` (async_return_signature, line 145)
//       params  = the *callee's* flattened results (+ a retptr when the caller
//                 is async-with-results, or when the caller's results spill)
//       results = the *caller's* flattened results (empty if async/spilled)
//     i.e. "given the callee's results, produce the caller's" — `on_resolve`.
//
// So the host never inspects a value: it calls `start` to get the callee's
// arguments, and calls `return` with whatever the callee produced. This is why
// a FACT task's payload is flat core values (`Task.factPassthrough`).
//
// Two details that fall out of the emission sites:
//
//   * `prepare-call` must NOT run the callee. The callee may be exerting
//     backpressure, and the whole point of splitting prepare from start is to
//     let the host stash the parameters until it clears (fact.rs:580-583).
//     The stashed state feeds `Task.enterImplicitThread`, which is exactly
//     where the reference's backpressure gate lives.
//   * Reentrance between *related* instances is resolved statically:
//     `trampoline.rs:116-127` emits an unconditional
//     `trap(Trap::CannotEnterComponent)` when the lower and lift instances are
//     the same or are ancestors of one another. So the flat-instance-tree gap
//     recorded in task/mod.ts is NOT load-bearing here — wasmtime has already
//     decided those cases at translation time, and the remaining runtime check
//     is the ordinary "is the callee instance currently executing" one, which
//     a flat tree answers correctly.

import { assert_, trapIf } from "../cabi/trap.ts";
import { MAX_FLAT_RESULTS } from "../cabi/mod.ts";
import type { CoreValue, FuncType, ValType } from "../cabi/types.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  NeedsJspi,
  currentTask,
  needsJspi,
  packSubtaskResult,
  PendingCapability,
  Subtask,
  SubtaskState,
  Task,
  type TaskOptions,
  Thread,
} from "../task/mod.ts";
import { blockCurrentActivation, enterWasm } from "../jspi/mod.ts";
import {
  awaitCore,
  callCore,
  type CoreFn,
  type ExecutionStats,
  normalizeCoreValues,
  runCallbackLoop,
} from "../exec/boundary.ts";
import { traceCopy } from "./stream_builtins.ts";

/** `PREPARE_ASYNC_NO_RESULT` (wasmtime-environ `component.rs:39`). */
const PREPARE_ASYNC_NO_RESULT = 0xffff_ffff;
/** `PREPARE_ASYNC_WITH_RESULT` (`component.rs:45`). */
const PREPARE_ASYNC_WITH_RESULT = 0xffff_fffe;
/** `START_FLAG_ASYNC_CALLEE` (`component.rs:52`). */
export const START_FLAG_ASYNC_CALLEE = 1;

/** Number of fixed leading parameters of `prepare-call` (`fact.rs:47`). */
const PREPARE_FIXED = 8;

/** The state `prepare-call` stashes for the following `*-start-call`. */
export interface PreparedCall {
  /** `[async-start]` adapter export — the reference's `on_start`. */
  start: CoreFn;
  /** `[async-return]` adapter export — the reference's `on_resolve`. */
  return_: CoreFn;
  callerInst: ComponentInstanceState;
  calleeInst: ComponentInstanceState;
  /** `TypeTupleIndex` of the callee's (lifted) results. */
  taskReturnType: number;
  /** Whether the callee's *function type* is async. */
  calleeAsync: boolean;
  stringEncoding: number;
  resultCountOrMax: number;
  /** The caller's own flat arguments, as forwarded to `prepare-call`. */
  params: CoreValue[];
  /**
   * Where the *caller's* results go, decoded from
   * `result_count_or_max_if_async` exactly as wasmtime's `ResultInfo`
   * (`concurrent.rs:2815-2836`):
   *
   *   * async caller **with** a result -> `Heap`, retptr = last param
   *   * async caller without a result  -> `Stack`
   *   * sync caller whose results spill (`result_count > MAX_FLAT_RESULTS`)
   *                                    -> `Heap`, retptr = last param
   *   * sync caller otherwise          -> `Stack`
   *
   * In the `Heap` case the retptr must be **appended** to the
   * `[async-return]` arguments (`concurrent.rs:2916-2919`) — it is the last
   * parameter of `async_return_signature` (fact/signature.rs:166,178), not
   * something the callee produced.
   */
  resultInfo: { kind: "heap"; retptr: CoreValue } | { kind: "stack" };
  /** True when the caller used the async ABI *and* has a result. */
  asyncCallerWithResult: boolean;
  /**
   * The memory `prepare-call` names (`component/info.rs:1059`: "the memory
   * used to verify that the memory specified for the `task.return` that is
   * called at runtime matches the one specified in the lifted export").
   *
   * Decoded faithfully, but NOT usable for that verification: it is the
   * *adapter's* view (`adapter.lift.options...memory`) and is `None` for
   * callees whose own `task.return` options do name a memory. wasmtime gets
   * away with the check because it holds the lift memory first-hand and its
   * comparison is one-sided (concurrent.rs:3344-3358). Kept because it is the
   * wire field and the task's options are structurally built from it; see the
   * comment on the memory half of the check in async_builtins.ts.
   */
  memory: unknown | null;
}

/** Executor services these intrinsics need. */
export interface FactCallContext {
  componentInstance(index: number): ComponentInstanceState;
  /** Element types of an interned results tuple (`task_return_type`). */
  resultTypes(index: number): ValType[];
  /** `RuntimeCallbackIndex` -> the callee's callback core function. */
  callback(index: number): CoreFn;
  /** `RuntimeMemoryIndex` -> the memory `task.return` must match, if any. */
  memoryToken(index: number): unknown;
  stats: ExecutionStats;
  /** Suspension discipline (jspi/bridge.ts). */
  suspensionMode: import("../jspi/mod.ts").SuspensionMode;
  /**
   * Can this specific callee's code reach a suspension point? Computed per
   * core instance at instantiation (see `Executor.suspendableFuncs`). Decides
   * whether the callee gets its own `promising` entry.
   */
  calleeCanBlock?(fn: unknown): boolean;
  /**
   * The single in-flight prepared call. wasmtime keeps this per *task*; a
   * single slot is equivalent here because `prepare-call` and its
   * `*-start-call` are emitted back-to-back in one adapter body
   * (`trampoline.rs:486-508`) with no suspension point between them, so two
   * preparations can never be outstanding at once. Asserted, not assumed.
   */
  prepared: { current: PreparedCall | null };
}

/** definitions.py-shaped canonical options a FACT task must remember. */
function taskOptionsFor(
  prepared: PreparedCall,
  callback: CoreFn | null,
  memory: unknown,
  calleeUsesAsyncAbi: boolean,
): TaskOptions {
  return {
    // NOTE the distinction definitions.py draws and this code initially got
    // wrong: `Task.ft.async` is the *function type*'s asyncness (what
    // `prepare-call` passes as `callee_async`), while `Task.opts.async_` is
    // the *canonical options*' asyncness — and `canon_lift` branches on the
    // latter (`if not opts.async_:` at line 2168). A function can be
    // async-*typed* yet lifted with sync options, in which case the reference
    // takes its plain synchronous path. Branching on the type instead sent
    // those callees down the stackful path and reported a bogus JSPI
    // requirement (`test/async/cross-abi-calls.wast`'s `async-calls-sync-*`).
    async_: calleeUsesAsyncAbi,
    callback: callback !== null,
    stringEncoding: stringEncodingName(prepared.stringEncoding),
    memory,
  };
}

/**
 * wasmtime's `StringEncoding` discriminant (`component/types.rs`), as passed
 * through `prepare-call`.
 */
function stringEncodingName(v: number): string {
  switch (v) {
    case 0:
      return "utf8";
    case 1:
      return "utf16";
    case 2:
      return "latin1+utf16";
    default:
      return "utf8";
  }
}

// ---------------------------------------------------------------------------
// prepare-call
// ---------------------------------------------------------------------------

export function createPrepareCall(
  decl: { memory: number | null },
  ctx: FactCallContext,
): CoreFn {
  return (...args: unknown[]) => {
    assert_(
      args.length >= PREPARE_FIXED,
      `prepare-call: expected at least ${PREPARE_FIXED} arguments`,
    );
    const [start, return_, callerI, calleeI, taskReturnType, calleeAsync, enc, rc_] =
      args;
    assert_(
      typeof start === "function" && typeof return_ === "function",
      "prepare-call: start/return must be funcrefs",
    );
    assert_(
      ctx.prepared.current === null,
      "prepare-call with a preparation already outstanding",
    );
    // GAP (tracked): wasmtime performs a `check_blocking` here —
    //   if let (CallerInfo::Sync { .. }, true) = (&caller_info, callee_async) {
    //       store.0.check_blocking()?;   // concurrent.rs:2802-2807
    //   }
    // i.e. a *sync-lowered* caller reaching an *async-typed* callee must
    // itself have been created by an async export, else it traps: only a task
    // that is allowed to block may make a blocking call. We cannot evaluate it
    // yet — it needs a "may this task block" bit on `Task`, which the reference
    // models through its thread/task structure rather than a flag. Its absence
    // means we accept some components wasmtime rejects; it never causes a
    // wrong answer for an accepted one. `test/async/trap-if-block-and-sync.wast`
    // is the file that exercises it, and that file is independently blocked on
    // the wasmparser pin drift, so nothing observable depends on it today.
    const params = args.slice(PREPARE_FIXED) as CoreValue[];
    const rc = Number(rc_) >>> 0;
    // wasmtime `ResultInfo` (concurrent.rs:2815-2836).
    const lastParam = (): CoreValue => {
      assert_(params.length > 0, "prepare-call: retptr missing");
      return params[params.length - 1];
    };
    let resultInfo: PreparedCall["resultInfo"];
    let asyncCallerWithResult = false;
    if (rc === PREPARE_ASYNC_WITH_RESULT) {
      resultInfo = { kind: "heap", retptr: lastParam() };
      asyncCallerWithResult = true;
    } else if (rc === PREPARE_ASYNC_NO_RESULT) {
      resultInfo = { kind: "stack" };
    } else if (rc > MAX_FLAT_RESULTS) {
      // Sync caller whose results spilled: the adapter appended a retptr to
      // its own parameters (`flatten_functype` lower/spill path).
      resultInfo = { kind: "heap", retptr: lastParam() };
    } else {
      resultInfo = { kind: "stack" };
    }
    ctx.prepared.current = {
      start: start as CoreFn,
      return_: return_ as CoreFn,
      callerInst: ctx.componentInstance(Number(callerI) >>> 0),
      calleeInst: ctx.componentInstance(Number(calleeI) >>> 0),
      taskReturnType: Number(taskReturnType) >>> 0,
      calleeAsync: Number(calleeAsync) !== 0,
      stringEncoding: Number(enc) >>> 0,
      resultCountOrMax: rc,
      params,
      memory: decl.memory === null ? null : ctx.memoryToken(decl.memory),
      resultInfo,
      asyncCallerWithResult,
    };
    // Deliberately does not touch the callee: see the header. The callee may
    // be under backpressure, and `*-start-call` is what runs it.
  };
}

// ---------------------------------------------------------------------------
// The shared callee activation
// ---------------------------------------------------------------------------

/**
 * Build the `Task` for a prepared call and the generator body that runs the
 * callee on it. Shared by both `*-start-call` forms; they differ only in how
 * they *wait* for the result.
 */
function mkCalleeTask(input: {
  prepared: PreparedCall;
  callee: CoreFn;
  callback: CoreFn | null;
  postReturn: CoreFn | null;
  ctx: FactCallContext;
  /**
   * Whether the callee was lifted with **async canonical options**
   * (`START_FLAG_ASYNC_CALLEE`). Distinct from `prepared.calleeAsync`, which
   * is the function *type*'s asyncness — see `taskOptionsFor`.
   */
  calleeUsesAsyncAbi: boolean;
  /** Suspension discipline for this instantiation (jspi/bridge.ts). */
  mode?: import("../jspi/mod.ts").SuspensionMode;
  /** Whether THIS callee can reach a suspension point. */
  canBlock?: boolean;
  /**
   * Called when `[async-start]` has actually run, i.e. when the callee really
   * started. wasmtime sets its `Status::Started` event at exactly this point,
   * inside the `lower_params` closure (concurrent.rs:2903-2908) — *not* when
   * the call was prepared. Under backpressure `enter_implicit_thread` blocks
   * first, so a subtask observed before this fires must still report STARTING.
   */
  onStarted?: () => void;
  /**
   * Receives the caller-side flat results produced by `[async-return]`, or
   * `null` when the callee resolved as *cancelled* (definitions.py
   * `Task.cancel` -> `on_resolve(None)`).
   */
  onCallerResults: (r: CoreValue[] | null) => void;
}): { task: Task; body: (t: Thread) => Generator<BlockRequest, void, Cancelled> } {
  const { prepared, callee, callback, postReturn, ctx, calleeUsesAsyncAbi } =
    input;
  // CONTRACT: default to `plain` when the context predates this field. Only
  // `jspi` may wrap, and wrapping a non-wasm callee throws outright, so the
  // conservative reading of an absent mode is "no suspension discipline".
  const mode = input.mode ?? "plain";
  // CONTRACT: default false -- a context that cannot answer the question gets
  // the non-wrapping (plain-shaped) behaviour, which is the conservative one:
  // it never forces asynchrony that the ABI forbids.
  const canBlock = input.canBlock ?? false;
  const memory = prepared.memory;
  const inst = prepared.calleeInst;

  // `ft` for the task: only `async` and `results` are consulted —
  // `Task.needsExclusive` reads the former, `canon_task_return`'s result-type
  // check reads the latter (which is why `prepare-call` carries
  // `task_return_type` at all: fact.rs's comment on `PrepareCall.memory` says
  // the same for the memory check).
  // CONTRACT: `task_return_type` arrives as wasmtime's *own* `TypeTupleIndex`
  // (a runtime argument, not a plan field), and the plan has no mapping from
  // that index space into `plan.types`. So the callee task cannot carry its
  // declared result types, and `canon_task_return`'s
  // `trap_if(result_type != task.ft.result)` check is skipped for FACT tasks
  // (see async_builtins.ts). The check is defence-in-depth — the adapter that
  // calls `task.return` is generated by wasmtime from the same type — but
  // losing it is real, and a plan v2 field mapping `TypeTupleIndex` to a
  // `plan.types` index would restore it. Reported as contract friction.
  const ft: FuncType = {
    params: [],
    results: [],
    async: prepared.calleeAsync,
  };

  const task = new Task(
    ft,
    taskOptionsFor(prepared, callback, memory, calleeUsesAsyncAbi),
    inst,
    // on_start: the adapter's `[async-start]` turns the caller's flat params
    // into the callee's flat params (fact/signature.rs:61).
    //
    // An async caller that has a result passes its retptr as the *last* flat
    // parameter; `[async-start]` does not declare it, so it is chopped off
    // here exactly as wasmtime does (concurrent.rs:2869-2876, "Async callers,
    // if they have a result, use the last parameter as a return pointer so
    // chop that off"). Sync callers forward everything directly.
    () => {
      const calleeArgs = callCore(
        prepared.start,
        prepared.asyncCallerWithResult
          ? prepared.params.slice(0, -1)
          : prepared.params,
      ) as CoreValue[];
      input.onStarted?.();
      return calleeArgs;
    },
    // on_resolve: the adapter's `[async-return]` turns the callee's flat
    // results into the caller's (fact/signature.rs:145).
    (result) => {
      if (result === null) {
        // Cancelled before returning: there is nothing for `[async-return]`
        // to copy. The subtask's CANCELLED_BEFORE_* state carries the news,
        // so signal it rather than a normal empty result.
        input.onCallerResults(null);
        return;
      }
      // `[async-return]` takes the callee's flat results and, when the
      // caller's results live in linear memory, the caller-supplied return
      // pointer as a trailing argument (fact/signature.rs:166,178; appended by
      // wasmtime at concurrent.rs:2916-2919). Omitting it made the adapter
      // read `undefined` for that parameter, which coerces to 0 — every
      // spilled result was written to linear-memory address 0.
      const args = result as CoreValue[];
      const withRetptr = prepared.resultInfo.kind === "heap"
        ? [...args, prepared.resultInfo.retptr]
        : args;
      input.onCallerResults(
        callCore(prepared.return_, withRetptr) as CoreValue[],
      );
    },
  );
  task.factPassthrough = true;

  const body = function* (
    thread: Thread,
  ): Generator<BlockRequest, void, Cancelled> {
    if (!(yield* task.enterImplicitThread(thread))) return;
    const calleeArgs = task.start();
    traceCopy(`mkCalleeTask callee canBlock=${canBlock} mode=${mode}`);
    // WASM ENTRY (3 of 3 that can reach a blocking built-in).
    //
    // The other two — a lifted export's core function and a callback export —
    // are entered through `awaitCore`, which establishes the
    // activation-attached ambient. This one was not, and it is precisely the
    // entry that owns a FACT sync-call bracket: `enter-sync-call` runs here
    // under this task, and if the callee suspends, the engine resumes it later
    // with no driver. Without the ambient travelling with the activation the
    // matching `exit-sync-call` had no task in scope at all (traced in M2
    // phase 3h as `ENTER-SYNC owner=K26` / `EXIT-SYNC owner=EXECUTOR`).
    //
    // Entries deliberately NOT wrapped: `realloc`, `post-return`, resource
    // destructors and the `[async-start]`/`[async-return]` copy adapters.
    // None of them may block — they cannot reach a canonical built-in that
    // suspends — so the engine can never resume them, and wrapping would only
    // cost an ALS frame on the hot copy path.
    // The callee is its own activation and must get its own `promising`
    // entry, not merely an ambient scope: otherwise it runs *inside* whatever
    // `Suspending` trampoline invoked us, putting our JS frame between the
    // caller's promising entry and any suspension the callee reaches --
    // `SuspendError: trying to suspend JS frames` (jspi pin (b), mechanics.ts
    // line 12). This is only coherent together with site 1 below blocking
    // rather than raising `NeedsJspi`, since a promising callee resolves on a
    // later turn by construction.
    // NOTE (M2 stackful round): this wrap is RIGHT for a callee that blocks and
    // Wrap ONLY a callee that can actually reach a suspension point.
    //
    // The wrap is required when the callee blocks: without its own `promising`
    // entry it would suspend inside whatever `Suspending` trampoline invoked
    // us, with our JS frame in between (`SuspendError: trying to suspend JS
    // frames`, jspi pin (b)). But `enterWasm` returns a Promise
    // unconditionally, so wrapping a callee that CANNOT block forces
    // asynchrony the ABI forbids: an eagerly-completing callee must report its
    // subtask RETURNED, and a wrapped one reports STARTED. That broke all six
    // `async-calls-sync-*` cases of cross-abi-calls.wast.
    //
    // There is no per-CALL discriminator -- the same call site serves both --
    // so the answer is per-callee, derived from whether the callee's core
    // instance imports any blocking trampoline (`Executor.suspendableFuncs`).
    const raw = yield* awaitCore(
      canBlock ? enterWasm(callee, mode) : callee,
      calleeArgs as CoreValue[],
      thread,
    );

    if (!calleeUsesAsyncAbi) {
      // Sync canonical options (definitions.py `canon_lift` line 2168, `if not
      // opts.async_`): the callee returns its results directly and resolves
      // before returning. Reached via `compile_async_to_sync_adapter`, which
      // passes flags without `START_FLAG_ASYNC_CALLEE`.
      task.return_(raw as CoreValue[]);
      if (postReturn !== null) {
        assert_(inst.mayLeave, "post-return with may_leave already false");
        inst.mayLeave = false;
        callCore(postReturn, raw as CoreValue[]);
        inst.mayLeave = true;
        ctx.stats.postReturnsRun++;
      }
      task.exitImplicitThread(thread);
      return;
    }

    if (callback === null) {
      // Stackful async lift -- definitions.py `canon_lift` line 2178:
      //
      //     if not opts.callback:
      //       [] = call_and_trap_on_throw(callee, flat_args)
      //       task.exit_implicit_thread()
      //       return
      //
      // That is the whole path. The callee runs to completion on its own
      // stack, returning NO results and calling `task.return` itself; any
      // blocking happened *inside* it, through the canonical built-ins. Which
      // is exactly what the callee's own `promising` entry provides when it
      // can block -- the `awaitCore` above parks the CALLEE's thread, not the
      // caller's, so nothing here parks an async-lowered caller (the mistake
      // the cross-abi differential caught).
      normalizeCoreValues(raw, [], "stackful callee result");
      task.exitImplicitThread(thread);
      return;
    }
    const [packed] = normalizeCoreValues(raw, ["i32"], "callee result") as [
      number,
    ];
    yield* runCallbackLoop({
      name: "fact-callee",
      task,
      thread,
      inst,
      callback: callback!,
      packed,
      stats: ctx.stats,
    });
    task.exitImplicitThread(thread);
  };

  return { task, body };
}

/** Take the outstanding preparation, or trap if the adapter skipped it. */
function takePrepared(ctx: FactCallContext, what: string): PreparedCall {
  const p = ctx.prepared.current;
  assert_(p !== null, `${what} without a preceding prepare-call`);
  ctx.prepared.current = null;
  return p!;
}

// ---------------------------------------------------------------------------
// sync-start-call
// ---------------------------------------------------------------------------

/**
 * A sync-lowered import calling an async-lifted export
 * (`compile_sync_to_async_adapter`, trampoline.rs:607). The caller's wasm frame
 * is blocked for the duration, so this must produce the results *now*.
 */
export function createSyncStartCall(
  decl: { callback: number | null },
  ctx: FactCallContext,
): CoreFn {
  return (callee?: unknown, _liftParamCount?: number) => {
    const prepared = takePrepared(ctx, "sync-start-call");
    assert_(typeof callee === "function", "sync-start-call: callee funcref");
    const callback = decl.callback === null
      ? null
      : ctx.callback(decl.callback);

    let callerResults: CoreValue[] | null = null;
    const { task, body } = mkCalleeTask({
      prepared,
      callee: callee as CoreFn,
      callback,
      postReturn: null,
      ctx,
      // `sync-start-call` exists only for "sync-lowered import to async-lifted
      // export" (fact.rs:608), so the callee always uses the async ABI.
      calleeUsesAsyncAbi: true,
      mode: ctx.suspensionMode,
      canBlock: ctx.calleeCanBlock?.(callee) ?? false,
      onCallerResults: (r) => {
        callerResults = r ?? [];
      },
    });

    // Reference `Store.lift`: the reentrance gate, with the *caller* as the
    // entering context (definitions.py `entering_set(caller)`).
    trapIf(
      !prepared.calleeInst.mayEnterFrom(prepared.callerInst),
      "cannot enter component instance",
    );
    prepared.calleeInst.enterFrom(prepared.callerInst);
    let ok = false;
    try {
      const thread = spawn(task, body);
      thread.resume();
      ok = true;
    } catch (e) {
      // A trap leaves the instance poisoned: `leave_to` is not reached
      // (definitions.py `Store.lift`, line 578). A *capability signal* does
      // not — see the `isCapabilitySignal` note in exec/boundary.ts.
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        prepared.calleeInst.leaveTo(prepared.callerInst);
      }
      throw e;
    }
    if (ok) prepared.calleeInst.leaveTo(prepared.callerInst);

    if (callerResults === null) {
      // The callee did not resolve within its first activation. definitions.py
      // `canon_lower`'s sync path blocks here — `thread.wait_until(
      // subtask.resolved)` (line 2286) — suspending the *caller's* wasm frame
      // while the scheduler runs other threads. That is JSPI role 2 (PLAN.md
      // §6), and it is the first place a purely stackless runtime genuinely
      // cannot proceed.
      //
      // Note this is NOT the sync driving loop of `canon_lift`: that loop
      // drives the callee instance's own threads and is only correct when the
      // callee can finish without anything from the caller. Here the caller is
      // mid-frame and may be exactly what the callee is waiting for, so
      // pumping the callee alone would spin rather than make progress.
      // Note: the callee's thread stays parked in `store.waiting` when we bail
      // here. That is deliberate — unwinding it would run callee cleanup the
      // guest never asked for — but it does mean the store keeps a thread that
      // will never be resumed. Harmless today (the enclosing host call is
      // failing anyway, and the instance is not poisoned because no trap
      // escaped a task), and it disappears once JSPI lets this path actually
      // block instead of bailing.
      if (ctx.suspensionMode === "jspi") {
        // JSPI role 2 (PLAN.md §6): park the *caller's* wasm activation until
        // the callee resolves, exactly as definitions.py `canon_lower`'s sync
        // path does with `thread.wait_until(subtask.resolved)` (line 2286).
        // The scheduler keeps ticking the callee meanwhile; when it produces
        // results our `readyFunc` goes true and the engine resumes the caller.
        //
        // Not cancellable: a sync-lowered caller has no way to observe or
        // request cancellation mid-call -- the reference's wait here carries
        // no cancellation branch.
        return blockCurrentActivation({
          store: prepared.callerInst.store,
          task: currentTask(),
          readyFunc: () => callerResults !== null,
          cancellable: false,
          produce: () => shapeResults(callerResults as CoreValue[] | null),
        });
      }
      needsJspi(
        "sync-start-call whose async-lifted callee did not resolve in its " +
          "first activation (the caller's wasm frame must block)",
      );
    }
    return shapeResults(callerResults as CoreValue[] | null);
  };
}

/** The core-ABI shape of a returned results vector (0 / 1 / many). */
function shapeResults(out: CoreValue[] | null): CoreValue | undefined {
  if (out === null || out.length === 0) return undefined;
  if (out.length === 1) return out[0];
  return out as unknown as CoreValue;
}

// ---------------------------------------------------------------------------
// async-start-call
// ---------------------------------------------------------------------------

/**
 * An async-lowered import calling any export (`compile_async_to_async_adapter`
 * / `compile_async_to_sync_adapter`). Returns the packed subtask status the
 * guest already knows how to interpret — the same
 * `state | (subtaski << 4)` encoding `canon_lower` produces
 * (definitions.py line 2308), so the caller's callback loop and waitable sets
 * work unchanged.
 */
export function createAsyncStartCall(
  decl: { callback: number | null; postReturn: number | null },
  ctx: FactCallContext,
): CoreFn {
  return (
    callee?: unknown,
    _paramCount?: number,
    _resultCount?: number,
    flags?: number,
  ) => {
    const prepared = takePrepared(ctx, "async-start-call");
    assert_(typeof callee === "function", "async-start-call: callee funcref");
    const callback = decl.callback === null
      ? null
      : ctx.callback(decl.callback);

    // The caller-side view of this call. Everything downstream — waitable
    // sets, `subtask.drop`, the SUBTASK event — is the machinery already built
    // for host-import subtasks in exec/boundary.ts.
    // Starts STARTING and becomes STARTED only when `[async-start]` runs (see
    // `onStarted`). A callee held at the backpressure gate is therefore
    // reported as STARTING, and the STARTED transition delivers its own event
    // if the guest has already been handed a subtask index.
    const subtask = new Subtask();

    let onProgress: () => void = () => {};

    const { task, body } = mkCalleeTask({
      prepared,
      callee: callee as CoreFn,
      callback,
      postReturn: decl.postReturn === null
        ? null
        : ctx.callback(decl.postReturn),
      ctx,
      // `compile_async_to_async_adapter` sets START_FLAG_ASYNC_CALLEE;
      // `compile_async_to_sync_adapter` passes 0 (trampoline.rs:508 and :764).
      calleeUsesAsyncAbi: ((flags ?? 0) & START_FLAG_ASYNC_CALLEE) !== 0,
      mode: ctx.suspensionMode,
      canBlock: ctx.calleeCanBlock?.(callee) ?? false,
      onStarted: () => {
        if (subtask.state === SubtaskState.STARTING) {
          subtask.state = SubtaskState.STARTED;
          // `onProgress` is a no-op until the guest has a handle for this
          // subtask, mirroring `canon_lower`'s `maybe_on_progress`
          // (definitions.py line 2296): a call that starts before
          // `async-start-call` returns reports STARTED in its packed result
          // instead, with no event.
          onProgress();
        }
      },
      onCallerResults: (r) => {
        // `[async-return]` already wrote the caller's results (through the
        // retptr the caller supplied), so there is nothing to carry here: the
        // guest learns of completion from the SUBTASK event.
        if (!subtask.resolved()) {
          subtask.resolve(
            r === null
              // definitions.py `canon_lower`'s `on_resolve` (line 2267): a
              // cancelled callee resolves CANCELLED_BEFORE_{STARTED,RETURNED}
              // depending on how far it got.
              ? (subtask.state === SubtaskState.STARTING
                ? SubtaskState.CANCELLED_BEFORE_STARTED
                : SubtaskState.CANCELLED_BEFORE_RETURNED)
              : SubtaskState.RETURNED,
            [],
          );
        }
        onProgress();
      },
    });
    // Cross-component cancellation: `subtask.cancel` forwards to the callee
    // task's `request_cancellation` (definitions.py line 519), which delivers
    // TASK_CANCELLED to a cancellable block point — for a callback-ABI callee
    // that is its WAIT/YIELD, so the guest observes the cancellation and calls
    // `task.cancel`, resolving this subtask CANCELLED_BEFORE_RETURNED.
    subtask.onCancel = (callerInst) => task.requestCancellation(callerInst);
    subtask.calleeTask = task;

    trapIf(
      !prepared.calleeInst.mayEnterFrom(prepared.callerInst),
      "cannot enter component instance",
    );
    prepared.calleeInst.enterFrom(prepared.callerInst);
    let ok = false;
    let thread: Thread;
    try {
      thread = spawn(task, body);
      thread.resume();
      ok = true;
    } catch (e) {
      // See the sync form above and `isCapabilitySignal` in exec/boundary.ts.
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        prepared.calleeInst.leaveTo(prepared.callerInst);
      }
      throw e;
    }
    if (ok) prepared.calleeInst.leaveTo(prepared.callerInst);

    const report = (): CoreValue => {
      if (subtask.resolved()) {
        // Eager completion: no handle, no event (definitions.py line 2293).
        subtask.deliverResolve();
        traceCopy(`async-start-call -> RETURNED (eager)`);
        return SubtaskState.RETURNED;
      }
      const subtaski = prepared.callerInst.handles.add(subtask);
      onProgress = () => subtask.setSubtaskPendingEvent(subtaski);
      const packed = packSubtaskResult(subtask.state, subtaski);
      traceCopy(
        `async-start-call -> state=${subtask.state} i=${subtaski} ` +
          `packed=0x${(packed as number).toString(16)}`,
      );
      return packed;
    };

    // NO WAIT FOR RESOLUTION HERE, deliberately. An async-lowered caller must
    // not block on its callee's *completion* -- that is the entire point of
    // async lowering: it takes a subtask handle and learns of completion
    // through events. An earlier attempt (M2 "Fix 1") parked the caller here
    // until the callee resolved. It made cross-abi-calls agree in both modes,
    // and it broke the thing it had no business touching: the caller's
    // activation was now suspended, so the sync-lowered parked caller of
    // `handshake_test.ts` was never resumed and the run hung. Correct-looking,
    // semantically wrong.
    //
    // What jspi mode DOES need is a wait for **determinacy** (jspi pin (j),
    // `fastpath_hop_test.ts`): the engine defers a promising callee's
    // continuation to a microtask at EVERY Suspending call -- even one whose
    // value was available synchronously -- so a callee the reference would
    // run to completion inside this call (`canon_lift` drives the thread to
    // its first real block point before `canon_lower` returns) is still
    // mid-hop when `report()` runs. Reporting then is reporting a state the
    // reference can never observe: STARTED for a call that eagerly RETURNED
    // (big-interleaving's `call-import` scripts), or a missed synchronous
    // cancellation (its `subtask-cancel` scripts).
    //
    // "Determinate" is exactly one of:
    //   * the subtask resolved (task.return ran mid-activation), or
    //   * the callee's thread finished (results flow through the body), or
    //   * the callee genuinely parked on a scheduler condition -- its
    //     SuspensionPoint (or its body's own wait) sits in `store.waiting`.
    // A genuinely-blocking callee reaches its first real block point without
    // anything from the caller, so unlike Fix 1 this wait cannot deadlock:
    // it is the reference's atomic run-to-first-block, reconstructed across
    // the engine's microtask hops.
    if (ctx.suspensionMode === "jspi") {
      const store = prepared.callerInst.store as unknown as {
        waiting: { task?: unknown }[];
      };
      const determinate = (): boolean =>
        subtask.resolved() ||
        thread.done() ||
        store.waiting.some((w) => w.task === task);
      if (!determinate()) {
        return blockCurrentActivation({
          store: prepared.callerInst.store,
          task: currentTask(),
          readyFunc: determinate,
          cancellable: false,
          produce: () => report(),
        });
      }
    }
    return report();
  };
}

/** Create a thread whose body needs a reference to the thread itself. */
function spawn(
  task: Task,
  body: (t: Thread) => Generator<BlockRequest, void, Cancelled>,
): Thread {
  let thread!: Thread;
  thread = new Thread(
    task,
    (function* (): Generator<BlockRequest, void, Cancelled> {
      yield* body(thread);
    })(),
  );
  return thread;
}
