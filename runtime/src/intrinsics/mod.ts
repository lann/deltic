// Host trampolines (contracts/intrinsics.md §B) and FACT-adapter intrinsic
// obligations (§A) — the M0 subset, with instantiate-time (never call-time)
// milestone-aware failures for everything else.
//
// Implemented in M0:
//   lower-import        host function call through descriptor-IR lift/lower
//   trap                FACT `Trap` import -> ComponentTrap
//   enter/exit-sync-call  degenerate sync-call bookkeeping (assert-and-count)
//   resource-new/rep/drop  sync resource paths over cabi handle tables
//                          (M1 schedule, implemented early: the resources
//                          fixture references them at instantiation)
//
// Everything else fails at instantiate time with the milestone at which
// intrinsics.md §B schedules it — "this component needs the M2 task core"
// is a feature, not a crash.

import {
  canonResourceDrop,
  canonResourceNew,
  canonResourceRep,
  trap,
} from "../cabi/mod.ts";
import { ResourceHandle } from "../cabi/handles.ts";
import { trapIf } from "../cabi/trap.ts";
import { assert_ } from "../cabi/trap.ts";
import type { ResourceTypeInfo } from "../cabi/types.ts";
import type { ComponentInstanceState } from "../task/mod.ts";
import { PendingCapability } from "../task/mod.ts";
import type { WireTrampoline } from "../plan/format.ts";
import type { CoreFn, ExecutionStats } from "../exec/boundary.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import {
  type AsyncTrampolineContext,
  createBackpressureDec,
  createBackpressureInc,
  createSubtaskCancel,
  createSubtaskDrop,
  createTaskCancel,
  createTaskReturn,
  createThreadYield,
  createWaitableJoin,
  createWaitableSetDrop,
  createWaitableSetNew,
  createWaitableSetPoll,
  createWaitableSetWait,
} from "./async_builtins.ts";
import {
  createAsyncStartCall,
  createPrepareCall,
  createSyncStartCall,
  type FactCallContext,
  type PreparedCall,
} from "./fact_calls.ts";
import {
  createErrorContextDebugMessage,
  createErrorContextDrop,
  createErrorContextNew,
  createFutureCancelRead,
  createFutureCancelWrite,
  createFutureDropReadable,
  createFutureDropWritable,
  createFutureNew,
  createFutureRead,
  createFutureWrite,
  createStreamCancelRead,
  createStreamCancelWrite,
  createStreamDropReadable,
  createStreamDropWritable,
  createStreamNew,
  createStreamRead,
  createStreamWrite,
  type StreamTrampolineContext,
  type AsyncTransferContext,
  createStreamTransfer,
  createFutureTransfer,
  createErrorContextTransfer,
} from "./stream_builtins.ts";
import {
  createTranscoder,
  type TranscodeMemory,
  type TranscodeOp,
  TRANSCODE_OPS,
} from "./transcode.ts";

export * from "./transcode.ts";
export * from "./context.ts";
export * from "./async_builtins.ts";
export * from "./fact_calls.ts";
export * from "./stream_builtins.ts";

/**
 * Where a host trap thrown *inside* a FACT adapter is remembered.
 *
 * FACT wraps every adapter body in a `try_table … catch_all` exception
 * barrier (wasmtime-environ 47.0.3 `fact/trampoline.rs:3939`
 * `enter_exception_barrier`) so that a guest exception escaping a component
 * becomes a trap rather than unwinding into the caller. In wasmtime a host
 * trap unwinds out of band and is unaffected; in a JS host our traps *are*
 * JS exceptions, so the barrier swallows them and re-raises the generic
 * `UncaughtException` FACT trap — which would violate contracts/intrinsics.md
 * §"Universal semantics" 2 ("traps ... must not be catchable by guest code").
 *
 * The fix is to remember the trap on the way out and restore it when the
 * barrier reports `UncaughtException`. A genuine guest exception leaves
 * `pending` untouched and keeps the generic trap.
 *
 * **Residual limitation (inherent to a JS host).** wasmtime's traps are
 * unforgeable and uncatchable: they unwind out of band, and no guest
 * construct can observe or swallow one. Ours are ordinary JS exceptions, so
 * a guest that wraps a call in its own `try_table (catch_all …)` *can* catch
 * a host trap mid-flight and continue — the Component Model says that must be
 * impossible. Recovering full unforgeability needs an out-of-band channel
 * (e.g. a poison flag consulted at every host boundary crossing) and is not
 * attempted here; the barrier case above is the one that occurs in practice,
 * because FACT emits it on every adapter. Recorded as a known gap.
 */
export interface HostTrapState {
  pending: unknown;
}

/**
 * Trap-code → message, from wasmtime-environ 47.0.3 `trap_encoding.rs`
 * (`generate_trap_type!`), whose ordinals are what FACT passes to the
 * `runtime.trap` import. Only the codes a sync FACT adapter can raise are
 * listed; anything else falls back to the numeric code.
 *
 * Rendered with wasmtime's `"wasm trap: "` prefix (its `impl Display for
 * Trap`), because that is the text the official suite's `assert_trap`
 * commands expect for adapter-raised traps
 * (e.g. `values/realloc.wast:67,94`).
 */
const FACT_TRAP_MESSAGES: Record<number, string> = {
  9: "wasm `unreachable` instruction executed",
  17: "cannot enter component instance",
  23: "cannot leave component instance",
  24: "cannot block a synchronous task before returning",
  25: "invalid `char` bit pattern",
  30: "string content out-of-bounds",
  31: "list content out-of-bounds",
  32: "invalid variant discriminant",
  33: "unaligned pointer",
  46: "reference count overflow",
  49: "uncaught exception propagated out of component",
};

/** Ordinal of `Trap::UncaughtException` in wasmtime's trap encoding. */
const TRAP_UNCAUGHT_EXCEPTION = 49;

export { UnsupportedFeatureError } from "./errors.ts";

/** Milestone at which each trampoline kind stops instantiate-failing. */
const TRAMPOLINE_MILESTONE: Record<string, "M0" | "M1" | "M2"> = {
  "lower-import": "M0",
  "trap": "M0",
  "enter-sync-call": "M0",
  "exit-sync-call": "M0",
  "resource-new": "M1",
  "resource-rep": "M1",
  "resource-drop": "M1",
  "transcoder": "M1",
  "resource-transfer-own": "M1",
  "resource-transfer-borrow": "M1",
};

function milestoneOf(kind: string): "M0" | "M1" | "M2" {
  return TRAMPOLINE_MILESTONE[kind] ?? "M2";
}

/**
 * The borrow bookkeeping of one in-flight synchronous cross-component call,
 * bracketed by the FACT adapter's `enter-sync-call` / `exit-sync-call`
 * imports (wasmtime-environ 47.0.3 `fact/trampoline.rs:810,904`: enter is
 * emitted *before* argument translation and exit *after* the callee returns,
 * so every resource transfer for the call happens inside the bracket).
 *
 * It plays the role definitions.py gives the callee `Subtask`/`Task`:
 *
 *  - `lenders` — handles lent to the callee (`Subtask.lenders`); each
 *    `num_lends` is dropped again when the call returns, which is what makes
 *    a lender's own handle liftable again afterwards.
 *  - `numBorrows` — borrow handles lowered into the callee's table
 *    (`Task.num_borrows`); the callee must drop them all before returning
 *    (definitions.py `Task.return_`: `trap_if(self.num_borrows > 0)`).
 *
 * Structurally satisfies cabi's `TaskBorrowScope` and `SubtaskBorrowScope`.
 */
export class SyncCallScope {
  numBorrows = 0;
  readonly lenders: ResourceHandle[] = [];

  /**
   * definitions.py `Subtask.add_lender` (line 890) — note there is **no**
   * `own` check, and `lift_borrow` (line 1516) calls it unconditionally: a
   * component that received a borrow may lend it onward, and the borrow
   * handle's own `num_lends` is what blocks `resource.drop` on it until the
   * onward call returns (`canon_resource_drop`, line 2325, traps on
   * `num_lends != 0` for owning *and* borrowed handles alike).
   * wasmtime 47.0.3 `vm/component/resources.rs:285` (`resource_lift_borrow`)
   * agrees.
   */
  addLender(h: ResourceHandle): void {
    h.numLends += 1;
    this.lenders.push(h);
  }

  /** definitions.py `Subtask.release_lenders`. */
  releaseLenders(): void {
    for (const h of this.lenders) h.numLends -= 1;
    this.lenders.length = 0;
  }
}

/** Executor services a trampoline body needs (provided by executor.ts). */
export interface TrampolineContext {
  componentInstance(index: number): ComponentInstanceState;
  resourceToken(index: number): ResourceTypeInfo;
  /**
   * The component instance that *owns* resource table `index`
   * (`TypeResourceTable::Concrete.instance`), i.e. whose handle table the
   * FACT transfer intrinsics move handles between. Throws for abstract
   * (type-only) tables, which have no runtime state.
   */
  resourceTableInstance(index: number): ComponentInstanceState;
  /**
   * A live view of runtime memory `index` (`RuntimeMemoryIndex`), for the
   * string-transcoder trampolines.
   */
  runtimeMemory(index: number): TranscodeMemory;
  /**
   * Stack of in-flight synchronous cross-component calls (innermost last),
   * owned by the executor so all trampolines of one instantiation share it.
   */
  syncCallStack: SyncCallScope[];
  /** See `HostTrapState`. */
  trapState: HostTrapState;
  /**
   * Resolved canonical options by index, and the element types of an interned
   * results tuple — needed by the async built-ins (task.return,
   * waitable-set.{wait,poll}). See `AsyncTrampolineContext`.
   */
  options(index: number): import("../exec/boundary.ts").ResolvedOptions;
  resultTypes(index: number): import("../cabi/types.ts").ValType[];
  /** `RuntimeCallbackIndex` -> the extracted callback core function. */
  callback(index: number): CoreFn;
  /** `RuntimeMemoryIndex` -> an identity token for `task.return` checks. */
  memoryToken(index: number): unknown;
  /** The single in-flight FACT preparation (see `PreparedCall`). */
  prepared: { current: PreparedCall | null };
  /** Suspension discipline (jspi/bridge.ts). */
  suspensionMode: import("../jspi/mod.ts").SuspensionMode;
  /** Element types of the plan v2 stream/future tables. */
  streamElem(index: number): import("../cabi/types.ts").ValType | null;
  futureElem(index: number): import("../cabi/types.ts").ValType | null;
  streamTableInstance(index: number): ComponentInstanceState;
  futureTableInstance(index: number): ComponentInstanceState;
  /** Build the lowered-import body for `lowered` (LoweredIndex). */
  loweredImport(decl: {
    lowered: number;
    options: number;
    type: number;
  }): CoreFn;
  stats: ExecutionStats;
}

/** Shared field shape of resource-new/rep/drop declarations. */
interface ResourceTrampolineDecl {
  instance: number;
  resource: number;
}

/**
 * Create the JS function backing one plan trampoline. Called during
 * initializer/arg/export resolution — i.e. at instantiate time — so an
 * unsupported kind fails instantiation, not the first call
 * (plan-format.md "Executor obligations"). Unreferenced trampolines are
 * never created and therefore never fail (intrinsics.md §B tolerates e.g.
 * an unreferenced task-return until M2).
 */
export function createTrampoline(
  decl: WireTrampoline,
  ctx: TrampolineContext,
): CoreFn {
  const fn = createTrampolineBody(decl, ctx);
  // Remember host traps so the FACT exception barrier cannot swallow them
  // (see `HostTrapState`). This wraps the `trap` trampoline too, which is
  // what keeps a specific trap specific across *nested* adapters: the inner
  // barrier's `trap` trampoline restores and rethrows the real trap, this
  // wrapper re-records it, and the outer barrier restores it again instead
  // of reporting the generic `UncaughtException`.
  return (...args: unknown[]) => {
    try {
      return fn(...args);
    } catch (e) {
      ctx.trapState.pending = e;
      throw e;
    }
  };
}

/**
 * A trampoline that instantiates fine but fails at its first call, naming the
 * phase that will implement it. See the CONTRACT note at the stream/future
 * cases for why these are not instantiate-time failures.
 */
function deferredCapability(kind: string, capability: string): CoreFn {
  return () => {
    throw new PendingCapability(
      `built-in '${kind}' is not implemented yet: ${capability}`,
    );
  };
}

/**
 * The component instance a trampoline is declared in (wasmtime names it in
 * every instance-scoped `Trampoline` variant). This is the static answer to
 * definitions.py's `current_instance()`, and unlike it, it is defined during
 * instantiation — when a core module's start function may already be calling
 * these built-ins. See the header of ./async_builtins.ts.
 */
/** Narrow the trampoline context to what the stream built-ins need. */
function sctx(ctx: TrampolineContext): StreamTrampolineContext {
  return ctx as unknown as StreamTrampolineContext;
}

function declaredInstance(
  decl: WireTrampoline,
  ctx: TrampolineContext,
): ComponentInstanceState {
  const instance = (decl as unknown as { instance?: number }).instance;
  assert_(
    typeof instance === "number",
    `trampoline '${decl.kind}' has no declared component instance`,
  );
  return ctx.componentInstance(instance);
}

function createTrampolineBody(
  decl: WireTrampoline,
  ctx: TrampolineContext,
): CoreFn {
  switch (decl.kind) {
    case "lower-import": {
      const d = decl as Extract<WireTrampoline, { kind: "lower-import" }>;
      return ctx.loweredImport(d);
    }

    case "trap":
      // FACT `runtime.trap` import: `(code: i32) -> ()` followed by
      // `unreachable` (wasmtime-environ `fact/trampoline.rs:3932`).
      return (code?: number) => {
        if (code === TRAP_UNCAUGHT_EXCEPTION) {
          const pending = ctx.trapState.pending;
          if (pending !== undefined) {
            // Deliberately *not* cleared: an enclosing adapter's barrier will
            // catch this rethrow and needs to restore the same trap. The slot
            // is reset per lifted-export call (exec/boundary.ts), which is
            // what bounds its lifetime.
            throw pending;
          }
        }
        const message = code === undefined
          ? undefined
          : FACT_TRAP_MESSAGES[code];
        trap(
          message === undefined
            ? `FACT adapter trap (code ${code ?? "?"})`
            : `wasm trap: ${message}`,
        );
      };

    // Sync-call task bookkeeping (intrinsics.md §A: "degenerate-case
    // implementation in M0: assert-and-count"). wasmtime 47 signatures:
    // enter-sync-call/exit-sync-call take no wasm-visible arguments that we
    // act on in M0; balance is asserted at component teardown by tests.
    // Signatures (wasmtime-environ 47.0.3 `fact.rs:743,754`):
    //   async.enter-sync-call(caller_instance: i32, async: i32,
    //                         callee_instance: i32) -> ()
    //   async.exit-sync-call() -> ()
    case "enter-sync-call":
      return (
        _callerInstance?: number,
        async_?: number,
        _calleeInstance?: number,
      ) => {
        // `async_` records whether the callee is *async-lifted*. wasmtime
        // stores it on the guest task it creates here
        // (`concurrent.rs:1723` `enter_guest_sync_call`, whose `callee_async`
        // parameter flows into `GuestTask::new`) and never traps on it.
        //
        // Before the task core existed this trampoline refused `async_ == 1`
        // rather than silently treating an async callee as sync. That guard is
        // now stale and actively wrong: a sync-lowered caller reaching an
        // async-lifted export is the `sync-start-call` path
        // (intrinsics/fact_calls.ts), and the task it needs is created by
        // `prepare-call`, not here. What remains of this bracket for us is the
        // borrow bookkeeping (`SyncCallScope`), which applies either way.
        void async_;
        ctx.stats.enterSyncCalls++;
        ctx.syncCallStack.push(new SyncCallScope());
      };
    case "exit-sync-call":
      return (..._args: unknown[]) => {
        ctx.stats.exitSyncCalls++;
        assert_(
          ctx.stats.exitSyncCalls <= ctx.stats.enterSyncCalls,
          "exit-sync-call without matching enter-sync-call",
        );
        const scope = ctx.syncCallStack.pop();
        assert_(
          scope !== undefined,
          "exit-sync-call with an empty sync-call stack",
        );
        // definitions.py `Task.return_`: the callee may not return while it
        // still holds borrow handles.
        trapIf(
          scope!.numBorrows > 0,
          "cannot return from a call with outstanding borrow handles",
        );
        scope!.releaseLenders();
      };

    // Guest-side resource built-ins (sync paths of PLAN.md §7 over the cabi
    // handle tables). rep is always i32 in current wasmtime.
    case "resource-new": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (rep: number) => canonResourceNew(inst, rt, rep >>> 0);
    }
    case "resource-rep": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (handle: number) => canonResourceRep(inst, rt, handle >>> 0);
    }
    case "resource-drop": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (handle: number) => {
        canonResourceDrop(inst, rt, handle >>> 0);
      };
    }

    // FACT resource transfer (contracts/intrinsics.md §A, wasmtime-environ
    // 47.0.3 `fact.rs:721` — signature `(i32 src_handle, i32 src_table,
    // i32 dst_table) -> i32 dst_handle`). These are the fused-adapter form of
    // `lift_own`/`lower_own` and `lift_borrow`/`lower_borrow`
    // (definitions.py) with the src/dst tables named by index rather than
    // implied by the running instance.
    // FACT string transcoders (contracts/intrinsics.md §B "M1"). The plan
    // carries the op name plus the source/destination `RuntimeMemoryIndex`es;
    // `./transcode.ts` holds the twelve operations.
    case "transcoder": {
      const d = decl as unknown as {
        op: string;
        from: number;
        from64: boolean;
        to: number;
        to64: boolean;
      };
      if (d.from64 || d.to64) {
        // 64-bit linear memories are out of scope (PLAN.md §16); refusing at
        // instantiate time keeps "instantiate-time, never call-time".
        throw new UnsupportedFeatureError(
          "M2",
          `transcoder '${d.op}' over a 64-bit linear memory`,
        );
      }
      if (!(TRANSCODE_OPS as readonly string[]).includes(d.op)) {
        throw new UnsupportedFeatureError(
          "M2",
          `unknown string transcode operation '${d.op}'`,
        );
      }
      return createTranscoder(
        d.op as TranscodeOp,
        ctx.runtimeMemory(d.from),
        ctx.runtimeMemory(d.to),
      ) as CoreFn;
    }

    // --- 0.3 async built-ins (contracts/intrinsics.md §B "M2") -------------
    // All ported in ./async_builtins.ts; the ones that would have to block a
    // wasm frame fail there, at the call site, with a JSPI-shaped message.
    case "task-return":
      return createTaskReturn(
        decl as unknown as { results: number; options: number },
        ctx as AsyncTrampolineContext,
      );
    case "task-cancel":
      return createTaskCancel();
    // No `backpressure-set` case on purpose: wasmtime-environ 47.0.3 has only
    // `Trampoline::BackpressureInc` / `BackpressureDec`
    // (`component/info.rs:775,781`) — there is no `BackpressureSet` variant to
    // dispatch, so a case for it would be unreachable code implying a wire
    // shape that cannot occur. definitions.py still carries
    // `canon_backpressure_set` (line 2368), but it is dead there too; see
    // upstream-component-model-repo-findings.md CM-2, where we propose its
    // removal upstream.
    case "backpressure-inc":
      return createBackpressureInc(declaredInstance(decl, ctx));
    case "backpressure-dec":
      return createBackpressureDec(declaredInstance(decl, ctx));
    case "waitable-set-new":
      return createWaitableSetNew(declaredInstance(decl, ctx));
    case "waitable-set-wait":
      return createWaitableSetWait(
        decl as unknown as { options: number },
        ctx as AsyncTrampolineContext,
        declaredInstance(decl, ctx),
      );
    case "waitable-set-poll":
      return createWaitableSetPoll(
        decl as unknown as { options: number },
        ctx as AsyncTrampolineContext,
        declaredInstance(decl, ctx),
      );
    case "waitable-set-drop":
      return createWaitableSetDrop(declaredInstance(decl, ctx));
    case "waitable-join":
      return createWaitableJoin(declaredInstance(decl, ctx));
    case "subtask-drop":
      return createSubtaskDrop(declaredInstance(decl, ctx));
    case "subtask-cancel":
      return createSubtaskCancel(
        decl as unknown as { async?: boolean },
        declaredInstance(decl, ctx),
      );
    case "thread-yield":
      return createThreadYield(decl as unknown as { cancellable?: boolean });

    // --- FACT cross-component calls (see ./fact_calls.ts) -----------------
    case "prepare-call":
      return createPrepareCall(
        decl as unknown as { memory: number | null },
        ctx as unknown as FactCallContext,
      );
    case "sync-start-call":
      return createSyncStartCall(
        decl as unknown as { callback: number | null },
        ctx as unknown as FactCallContext,
      );
    case "async-start-call":
      return createAsyncStartCall(
        decl as unknown as { callback: number | null; postReturn: number | null },
        ctx as unknown as FactCallContext,
      );

    // --- stream / future / error-context (see ./stream_builtins.ts) -------
    case "stream-new":
      return createStreamNew(
        decl as unknown as { streamTable: number },
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "future-new":
      return createFutureNew(
        decl as unknown as { futureTable: number },
        sctx(ctx),
        declaredInstance(decl, ctx),
      );
    case "stream-read":
      return createStreamRead(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "stream-write":
      return createStreamWrite(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "future-read":
      return createFutureRead(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "future-write":
      return createFutureWrite(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "stream-cancel-read":
      return createStreamCancelRead(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "stream-cancel-write":
      return createStreamCancelWrite(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "future-cancel-read":
      return createFutureCancelRead(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "future-cancel-write":
      return createFutureCancelWrite(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "stream-drop-readable":
      return createStreamDropReadable(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "stream-drop-writable":
      return createStreamDropWritable(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "future-drop-readable":
      return createFutureDropReadable(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "future-drop-writable":
      return createFutureDropWritable(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "error-context-new":
      return createErrorContextNew(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "error-context-debug-message":
      return createErrorContextDebugMessage(decl as never, sctx(ctx), declaredInstance(decl, ctx));
    case "error-context-drop":
      return createErrorContextDrop(declaredInstance(decl, ctx));
    case "stream-transfer":
      return createStreamTransfer(ctx as unknown as AsyncTransferContext);
    case "future-transfer":
      return createFutureTransfer(ctx as unknown as AsyncTransferContext);
    case "error-context-transfer":
      return createErrorContextTransfer(
        ctx as unknown as AsyncTransferContext,
        // error-context tables are per component instance but the plan has no
        // separate table section for them; the resource-table instance mapping
        // is the same index space wasmtime uses for the transfer's arguments.
        (t) => ctx.resourceTableInstance(t),
      );

    case "resource-transfer-own":
      return (handle: number, srcTable: number, dstTable: number) =>
        transferOwn(ctx, handle >>> 0, srcTable, dstTable);
    case "resource-transfer-borrow":
      return (handle: number, srcTable: number, dstTable: number) =>
        transferBorrow(ctx, handle >>> 0, srcTable, dstTable);

    default:
      throw new UnsupportedFeatureError(
        milestoneOf(decl.kind) === "M1" ? "M1" : "M2",
        `component requires host trampoline '${decl.kind}'`,
      );
  }
}


// ---------------------------------------------------------------------------
// Resource transfer (FACT `resource.transfer-own` / `transfer-borrow`)
// ---------------------------------------------------------------------------

/**
 * `lift_own` out of the source table followed by `lower_own` into the
 * destination table (definitions.py `lift_own` / `lower_own`): the source
 * handle is *removed* (ownership moves), must be owning, and must not be
 * lent out.
 */
function transferOwn(
  ctx: TrampolineContext,
  handle: number,
  srcTable: number,
  dstTable: number,
): number {
  const src = ctx.resourceTableInstance(srcTable);
  const dst = ctx.resourceTableInstance(dstTable);
  const srcRt = ctx.resourceToken(srcTable);
  const dstRt = ctx.resourceToken(dstTable);

  const h = src.handles.remove(handle);
  trapIf(!(h instanceof ResourceHandle), "transfer-own: not a resource handle");
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== srcRt, "transfer-own: resource type mismatch");
  // definitions.py `lift_own`: `trap_if(h.num_lends != 0)`.
  trapIf(
    rh.numLends !== 0,
    "cannot remove owned resource while borrowed (handle still lent out)",
  );
  trapIf(!rh.own, "transfer-own: expected an owning handle");
  return dst.handles.add(new ResourceHandle(dstRt, rh.rep, true));
}

/**
 * `lift_borrow` from the source table followed by `lower_borrow` into the
 * destination table. The source handle stays in place; the destination gets a
 * non-owning handle.
 *
 * Two deviations from the plain lift/lower pair, both taken from
 * definitions.py:
 *
 *  - `lower_borrow` returns the *rep* directly when the destination instance
 *    is the one that implements the resource ("own the resource" fast path),
 *    since a component always has direct access to its own reps.
 *  - lender / `num_borrows` bookkeeping is attached to the enclosing
 *    `SyncCallScope` (the `enter-sync-call` / `exit-sync-call` bracket),
 *    which is this path's stand-in for the callee `Subtask`/`Task` of
 *    definitions.py.
 */
// CONTRACT: contracts/intrinsics.md §A schedules ResourceTransfer* at "M1,
// resources milestone" and describes them only as "handle-table moves between
// component instances" — the borrow-scope interaction is unspecified there.
// The reading implemented here is taken from definitions.py
// (`lift_borrow`/`lower_borrow` + `Subtask.lenders`/`Task.num_borrows`) and
// is what makes `test/resources/borrows.wast:162` (`lend-trap`) trap.
function transferBorrow(
  ctx: TrampolineContext,
  handle: number,
  srcTable: number,
  dstTable: number,
): number {
  const src = ctx.resourceTableInstance(srcTable);
  const dst = ctx.resourceTableInstance(dstTable);
  const srcRt = ctx.resourceToken(srcTable);
  const dstRt = ctx.resourceToken(dstTable);

  const scope = ctx.syncCallStack[ctx.syncCallStack.length - 1];
  assert_(
    scope !== undefined,
    "transfer-borrow outside an enter-sync-call/exit-sync-call bracket",
  );

  const h = src.handles.get(handle);
  trapIf(
    !(h instanceof ResourceHandle),
    "transfer-borrow: not a resource handle",
  );
  const rh = h as ResourceHandle;
  trapIf(rh.rt !== srcRt, "transfer-borrow: resource type mismatch");
  // definitions.py `lift_borrow`: the source handle becomes a lender of the
  // callee's activation, which is what makes lifting it as an `own` trap for
  // the duration of the call.
  scope.addLender(rh);
  // definitions.py `lower_borrow`: `if inst is t.rt.impl: return rep` — a
  // component that implements the resource is handed the rep directly and
  // gets no handle (and therefore no `num_borrows` obligation).
  if (dstRt.impl !== null && (dstRt.impl as unknown) === dst) return rh.rep;
  scope.numBorrows += 1;
  return dst.handles.add(new ResourceHandle(dstRt, rh.rep, false, scope));
}
