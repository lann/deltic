// The stream / future / error-context canonical built-ins
// (definitions.py `canon_stream_new` line 2511 through `canon_error_context_drop`
// line 2810).
//
// The copy built-ins all share one shape, which is worth stating once:
//
//   1. validate the end (right class, right element type, IDLE, and — for the
//      synchronous form — not already in a waitable set);
//   2. build a `GuestBuffer` over the caller's memory;
//   3. set `CopyState.COPYING` and hand the buffer to the shared object, which
//      either parks it or rendezvouses with the other side;
//   4. if an event landed synchronously (rendezvous happened, or the stream was
//      already dropped) return its packed payload; otherwise the call is
//      *blocked* — `BLOCKED` for the async form, and for the sync form a
//      genuine wasm-frame block, i.e. JSPI.
//
// Step 4 is where the reference's `e.wait_for_pending_event()` sits. A
// stackless runtime cannot do that, so the sync form returns its answer when
// the rendezvous already happened and reports `NeedsJspi` otherwise — the same
// rule already applied to `waitable-set.wait` and `sync-start-call`.

import { assert_, trapIf } from "../cabi/trap.ts";
import { LiftLowerContext } from "../cabi/context.ts";
import { loadStringFromRange, storeString } from "../cabi/strings.ts";
import type { ValType } from "../cabi/types.ts";
import {
  BUFFER_MAX_LENGTH,
  type ComponentInstanceState,
  CopyEnd,
  CopyResult,
  CopyState,
  currentInstance,
  currentTask,
  ErrorContext,
  EventCode,
  type EventTuple,
  GuestBuffer,
  needsJspi,
  ReadableFutureEnd,
  ReadableStreamEnd,
  SharedFutureImpl,
  SharedStreamImpl,
  sameElemType as sameElem,
  WritableFutureEnd,
  WritableStreamEnd,
} from "../task/mod.ts";
import { cabiOptions, type CoreFn, type ResolvedOptions } from "../exec/boundary.ts";
import { BLOCKED } from "./async_builtins.ts";

/** Services the stream/future built-ins need from the executor. */
export interface StreamTrampolineContext {
  componentInstance(index: number): ComponentInstanceState;
  options(index: number): ResolvedOptions;
  /** Element type of a `TypeStreamTableIndex` (plan v2 `streamTables`). */
  streamElem(index: number): ValType | null;
  /** Element type of a `TypeFutureTableIndex` (plan v2 `futureTables`). */
  futureElem(index: number): ValType | null;
}

// ---------------------------------------------------------------------------
// stream.new / future.new
// ---------------------------------------------------------------------------

/**
 * definitions.py `canon_stream_new` (line 2511) / `canon_future_new` (2519).
 * Returns both handles packed into an i64: `ri | (wi << 32)`.
 */
export function createStreamNew(
  decl: { streamTable: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  return () => {
    trapIf(!inst.mayLeave, "stream.new: cannot leave component instance");
    const shared = new SharedStreamImpl(ctx.streamElem(decl.streamTable));
    const ri = inst.handles.add(new ReadableStreamEnd(shared));
    const wi = inst.handles.add(new WritableStreamEnd(shared));
    return packEnds(ri, wi);
  };
}

export function createFutureNew(
  decl: { futureTable: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  return () => {
    trapIf(!inst.mayLeave, "future.new: cannot leave component instance");
    const shared = new SharedFutureImpl(ctx.futureElem(decl.futureTable));
    const ri = inst.handles.add(new ReadableFutureEnd(shared));
    const wi = inst.handles.add(new WritableFutureEnd(shared));
    return packEnds(ri, wi);
  };
}

/** `ri | (wi << 32)` as an i64 core value. */
function packEnds(ri: number, wi: number): bigint {
  return BigInt(ri >>> 0) | (BigInt(wi >>> 0) << 32n);
}

// ---------------------------------------------------------------------------
// stream.{read,write}
// ---------------------------------------------------------------------------

type EndCtor = new (shared: never) => CopyEnd;

/** definitions.py `stream_copy` (line 2537). */
function streamCopy(input: {
  EndT: EndCtor;
  reading: boolean;
  eventCode: EventCode;
  elem: ValType | null;
  opts: ResolvedOptions;
  inst: ComponentInstanceState;
  i: number;
  ptr: number;
  n: number;
}): number {
  const { EndT, reading, eventCode, elem, opts, inst, i, ptr, n } = input;
  trapIf(!inst.mayLeave, "stream copy: cannot leave component instance");
  const e = inst.handles.get(i);
  trapIf(!(e instanceof EndT), "stream copy: wrong end type for this handle");
  const end = e as ReadableStreamEnd | WritableStreamEnd;
  trapIf(!sameElem(end.shared.t, elem), "stream copy: element type mismatch");
  // wasmtime distinguishes the two non-IDLE states in its message, and the
  // suite asserts the exact text: DONE means the other end has gone away (or
  // this end's single-shot operation already finished), COPYING means the
  // guest issued a second operation while one was in flight.
  trapIf(
    end.state === CopyState.DONE,
    reading
      ? "cannot read from stream after being notified that the writable end dropped"
      : "cannot write to stream after being notified that the readable end dropped",
  );
  trapIf(
    end.state !== CopyState.IDLE,
    "cannot have concurrent operations active on a future/stream",
  );
  trapIf(
    end.inWaitableSet() && !opts.async,
    "synchronous stream copy on an end that is in a waitable set",
  );

  const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
  const buffer = new GuestBuffer(elem, cx, ptr, n);

  // definitions.py `stream_event`: the payload is computed at *delivery* time,
  // so `buffer.progress` reflects everything copied by the time the guest
  // looks — including copies that happened after the event was armed.
  const streamEvent = (
    result: CopyResult,
    reclaim: () => void,
  ): EventTuple => {
    reclaim();
    assert_(end.copying(), "stream event on a non-copying end");
    end.state = result === CopyResult.DROPPED
      ? CopyState.DONE
      : CopyState.IDLE;
    assert_(
      buffer.progress <= BUFFER_MAX_LENGTH,
      "stream progress out of packing range",
    );
    return [eventCode, i, (result | (buffer.progress << 4)) >>> 0];
  };

  end.state = CopyState.COPYING;
  const onCopy = (reclaim: () => void) =>
    end.setPendingEvent(() => streamEvent(CopyResult.COMPLETED, reclaim));
  const onCopyDone = (result: CopyResult) =>
    end.setPendingEvent(() => streamEvent(result, () => {}));

  if (reading) {
    (end as ReadableStreamEnd).copy(inst, buffer, onCopy, onCopyDone);
  } else {
    (end as WritableStreamEnd).copy(inst, buffer, onCopy, onCopyDone);
  }
  return finishCopy(end, eventCode, i, opts.async, "stream");
}

// ---------------------------------------------------------------------------
// future.{read,write}
// ---------------------------------------------------------------------------

/** definitions.py `future_copy` (line 2591). */
function futureCopy(input: {
  EndT: EndCtor;
  reading: boolean;
  eventCode: EventCode;
  elem: ValType | null;
  opts: ResolvedOptions;
  inst: ComponentInstanceState;
  i: number;
  ptr: number;
}): number {
  const { EndT, reading, eventCode, elem, opts, inst, i, ptr } = input;
  trapIf(!inst.mayLeave, "future copy: cannot leave component instance");
  const e = inst.handles.get(i);
  trapIf(!(e instanceof EndT), "future copy: wrong end type for this handle");
  const end = e as ReadableFutureEnd | WritableFutureEnd;
  trapIf(!sameElem(end.shared.t, elem), "future copy: element type mismatch");
  // The writable side reaches DONE by two different routes — its own write
  // completed, or it was notified the readable end dropped — and wasmtime's
  // message names both (`futures_and_streams.rs:3522`). The shorter text the
  // other two assertions in `trap-if-done.wast` use (:446, :448) is a prefix
  // of this one, so the single full string satisfies all three.
  trapIf(
    end.state === CopyState.DONE,
    reading
      ? "cannot read from future after previous read succeeded"
      : "cannot write to future after previous write succeeded or readable end dropped",
  );
  trapIf(
    end.state !== CopyState.IDLE,
    "cannot have concurrent operations active on a future/stream",
  );
  trapIf(
    end.inWaitableSet() && !opts.async,
    "synchronous future copy on an end that is in a waitable set",
  );

  const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
  const buffer = new GuestBuffer(elem, cx, ptr, 1);

  const futureEvent = (result: CopyResult): EventTuple => {
    assert_(
      (buffer.remain() === 0) === (result === CopyResult.COMPLETED),
      "future event/progress disagreement",
    );
    assert_(end.copying(), "future event on a non-copying end");
    // A future is single-shot: both COMPLETED and DROPPED retire the end.
    end.state = result === CopyResult.DROPPED || result === CopyResult.COMPLETED
      ? CopyState.DONE
      : CopyState.IDLE;
    return [eventCode, i, result];
  };

  end.state = CopyState.COPYING;
  const onCopyDone = (result: CopyResult) => {
    assert_(
      result !== CopyResult.DROPPED || eventCode === EventCode.FUTURE_WRITE,
      "a readable future end cannot observe DROPPED",
    );
    end.setPendingEvent(() => futureEvent(result));
  };

  if (reading) {
    (end as ReadableFutureEnd).copy(inst, buffer, onCopyDone);
  } else {
    (end as WritableFutureEnd).copy(inst, buffer, onCopyDone);
  }
  return finishCopy(end, eventCode, i, opts.async, "future");
}

/**
 * The shared tail of `stream_copy` / `future_copy`: deliver the event if one
 * landed, else block.
 */
function finishCopy(
  end: CopyEnd,
  eventCode: EventCode,
  i: number,
  async_: boolean,
  what: string,
): number {
  if (!end.hasPendingEvent()) {
    if (!async_) {
      // definitions.py `e.wait_for_pending_event()`: block this wasm frame
      // until the other end shows up.
      needsJspi(
        `synchronous ${what} copy with no counterpart ready (the calling ` +
          `wasm frame must block until the other end arrives)`,
      );
    }
    return BLOCKED;
  }
  const [code, index, payload] = end.getPendingEvent();
  assert_(
    code === eventCode && index === i,
    `unexpected event delivered by a ${what} copy`,
  );
  return payload;
}

// ---------------------------------------------------------------------------
// cancel-{read,write}
// ---------------------------------------------------------------------------

/** definitions.py `cancel_copy` (line 2643). */
function cancelCopy(input: {
  EndT: EndCtor;
  eventCode: EventCode;
  elem: ValType | null;
  inst: ComponentInstanceState;
  async_: boolean;
  i: number;
  what: string;
}): number {
  const { EndT, eventCode, elem, inst, async_, i, what } = input;
  trapIf(!inst.mayLeave, `${what}: cannot leave component instance`);
  const e = inst.handles.get(i);
  trapIf(!(e instanceof EndT), `${what}: wrong end type for this handle`);
  const end = e as CopyEnd;
  trapIf(!sameElem(end.shared.t, elem), `${what}: element type mismatch`);
  trapIf(
    end.state !== CopyState.COPYING || end.hasSyncWaiter,
    `${what}: end is not in a cancellable copy`,
  );
  trapIf(
    end.inWaitableSet() && !async_,
    `${what}: synchronous cancel on an end that is in a waitable set`,
  );
  end.state = CopyState.CANCELLING_COPY;
  if (!end.hasPendingEvent()) {
    end.shared.cancel();
    if (!end.hasPendingEvent()) {
      if (!async_) {
        needsJspi(
          `synchronous ${what} whose copy did not settle immediately (the ` +
            `calling wasm frame must block)`,
        );
      }
      return BLOCKED;
    }
  }
  const [code, index, payload] = end.getPendingEvent();
  assert_(
    !end.copying() && code === eventCode && index === i,
    `unexpected event delivered by ${what}`,
  );
  return payload;
}

// ---------------------------------------------------------------------------
// drop-{readable,writable}
// ---------------------------------------------------------------------------

/** definitions.py `drop` (line 2677). */
function dropEnd(
  EndT: EndCtor,
  elem: ValType | null,
  inst: ComponentInstanceState,
  hi: number,
  what: string,
): void {
  trapIf(!inst.mayLeave, `${what}: cannot leave component instance`);
  const e = inst.handles.remove(hi);
  trapIf(!(e instanceof EndT), `${what}: wrong end type for this handle`);
  const end = e as CopyEnd;
  trapIf(!sameElem(end.shared.t, elem), `${what}: element type mismatch`);
  end.drop();
}

// ---------------------------------------------------------------------------
// error-context
// ---------------------------------------------------------------------------

/**
 * definitions.py `canon_error_context_new` (line 2785).
 *
 * The reference is deliberately non-committal about the message: under
 * `DETERMINISTIC_PROFILE` it stores the empty string, otherwise it may apply a
 * `host_defined_transformation`. We keep the guest's message verbatim — the
 * most useful behaviour for a debugging aid, and within what the spec allows
 * (the message is explicitly not semantically load-bearing).
 */
export function createErrorContextNew(
  decl: { options: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(decl.options);
  return (ptr?: number, taggedCodeUnits?: number) => {
    trapIf(!inst.mayLeave, "error-context.new: cannot leave component instance");
    const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
    const s = loadStringFromRange(cx, ptr ?? 0, taggedCodeUnits ?? 0);
    return inst.handles.add(new ErrorContext(s));
  };
}

/** definitions.py `canon_error_context_debug_message` (line 2799). */
export function createErrorContextDebugMessage(
  decl: { options: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(decl.options);
  return (i?: number, ptr?: number) => {
    trapIf(
      !inst.mayLeave,
      "error-context.debug-message: cannot leave component instance",
    );
    const e = inst.handles.get(i ?? 0);
    trapIf(
      !(e instanceof ErrorContext),
      "error-context.debug-message: handle is not an error-context",
    );
    const cx = new LiftLowerContext(cabiOptions(opts), inst, null);
    storeString(cx, (e as ErrorContext).debugMessage, ptr ?? 0);
  };
}

/** definitions.py `canon_error_context_drop` (line 2810). */
export function createErrorContextDrop(
  inst: ComponentInstanceState,
): CoreFn {
  return (i?: number) => {
    trapIf(
      !inst.mayLeave,
      "error-context.drop: cannot leave component instance",
    );
    const e = inst.handles.remove(i ?? 0);
    trapIf(
      !(e instanceof ErrorContext),
      "error-context.drop: handle is not an error-context",
    );
  };
}

// ---------------------------------------------------------------------------
// Trampoline factories
// ---------------------------------------------------------------------------

export function createStreamRead(
  d: { streamTable: number; options: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(d.options);
  const elem = ctx.streamElem(d.streamTable);
  return (i?: number, ptr?: number, n?: number) =>
    streamCopy({
      EndT: ReadableStreamEnd as unknown as EndCtor,
      reading: true,
      eventCode: EventCode.STREAM_READ,
      elem,
      opts,
      inst,
      i: i ?? 0,
      ptr: ptr ?? 0,
      n: n ?? 0,
    });
}

export function createStreamWrite(
  d: { streamTable: number; options: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(d.options);
  const elem = ctx.streamElem(d.streamTable);
  return (i?: number, ptr?: number, n?: number) =>
    streamCopy({
      EndT: WritableStreamEnd as unknown as EndCtor,
      reading: false,
      eventCode: EventCode.STREAM_WRITE,
      elem,
      opts,
      inst,
      i: i ?? 0,
      ptr: ptr ?? 0,
      n: n ?? 0,
    });
}

export function createFutureRead(
  d: { futureTable: number; options: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(d.options);
  const elem = ctx.futureElem(d.futureTable);
  return (i?: number, ptr?: number) =>
    futureCopy({
      EndT: ReadableFutureEnd as unknown as EndCtor,
      reading: true,
      eventCode: EventCode.FUTURE_READ,
      elem,
      opts,
      inst,
      i: i ?? 0,
      ptr: ptr ?? 0,
    });
}

export function createFutureWrite(
  d: { futureTable: number; options: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const opts = ctx.options(d.options);
  const elem = ctx.futureElem(d.futureTable);
  return (i?: number, ptr?: number) =>
    futureCopy({
      EndT: WritableFutureEnd as unknown as EndCtor,
      reading: false,
      eventCode: EventCode.FUTURE_WRITE,
      elem,
      opts,
      inst,
      i: i ?? 0,
      ptr: ptr ?? 0,
    });
}

export function createStreamCancelRead(
  d: { streamTable: number; async: boolean },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.streamElem(d.streamTable);
  return (i?: number) =>
    cancelCopy({
      EndT: ReadableStreamEnd as unknown as EndCtor,
      eventCode: EventCode.STREAM_READ,
      elem,
      inst,
      async_: d.async === true,
      i: i ?? 0,
      what: "stream.cancel-read",
    });
}

export function createStreamCancelWrite(
  d: { streamTable: number; async: boolean },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.streamElem(d.streamTable);
  return (i?: number) =>
    cancelCopy({
      EndT: WritableStreamEnd as unknown as EndCtor,
      eventCode: EventCode.STREAM_WRITE,
      elem,
      inst,
      async_: d.async === true,
      i: i ?? 0,
      what: "stream.cancel-write",
    });
}

export function createFutureCancelRead(
  d: { futureTable: number; async: boolean },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.futureElem(d.futureTable);
  return (i?: number) =>
    cancelCopy({
      EndT: ReadableFutureEnd as unknown as EndCtor,
      eventCode: EventCode.FUTURE_READ,
      elem,
      inst,
      async_: d.async === true,
      i: i ?? 0,
      what: "future.cancel-read",
    });
}

export function createFutureCancelWrite(
  d: { futureTable: number; async: boolean },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.futureElem(d.futureTable);
  return (i?: number) =>
    cancelCopy({
      EndT: WritableFutureEnd as unknown as EndCtor,
      eventCode: EventCode.FUTURE_WRITE,
      elem,
      inst,
      async_: d.async === true,
      i: i ?? 0,
      what: "future.cancel-write",
    });
}

export function createStreamDropReadable(
  d: { streamTable: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.streamElem(d.streamTable);
  return (i?: number) =>
    dropEnd(
      ReadableStreamEnd as unknown as EndCtor,
      elem,
      inst,
      i ?? 0,
      "stream.drop-readable",
    );
}

export function createStreamDropWritable(
  d: { streamTable: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.streamElem(d.streamTable);
  return (i?: number) =>
    dropEnd(
      WritableStreamEnd as unknown as EndCtor,
      elem,
      inst,
      i ?? 0,
      "stream.drop-writable",
    );
}

export function createFutureDropReadable(
  d: { futureTable: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.futureElem(d.futureTable);
  return (i?: number) =>
    dropEnd(
      ReadableFutureEnd as unknown as EndCtor,
      elem,
      inst,
      i ?? 0,
      "future.drop-readable",
    );
}

export function createFutureDropWritable(
  d: { futureTable: number },
  ctx: StreamTrampolineContext,
  inst: ComponentInstanceState,
): CoreFn {
  const elem = ctx.futureElem(d.futureTable);
  return (i?: number) =>
    dropEnd(
      WritableFutureEnd as unknown as EndCtor,
      elem,
      inst,
      i ?? 0,
      "future.drop-writable",
    );
}

/** Unused-import guards. */
void currentInstance;
void currentTask;

// ---------------------------------------------------------------------------
// FACT {stream,future,error-context}-transfer
// ---------------------------------------------------------------------------
//
// The fused-adapter form of `lift_async_value` + `lower_stream`/`lower_future`
// (definitions.py lines 1530 / 1828), with the source and destination tables
// named by index rather than implied by the running instance — exactly the
// arrangement `resource.transfer-own` already uses. Signature (wasmtime
// `vm/component/libcalls.rs:567,576,585`):
//     (src_idx: i32, src_table: i32, dst_table: i32) -> i32 dst_idx
//
// Transferring moves the *readable* end: the writable end, if this component
// still holds one, stays where it is. The shared object is passed by identity,
// which is what keeps the two components' copies rendezvousing.

/** Services the transfer intrinsics need beyond `StreamTrampolineContext`. */
export interface AsyncTransferContext extends StreamTrampolineContext {
  streamTableInstance(index: number): ComponentInstanceState;
  futureTableInstance(index: number): ComponentInstanceState;
}

function transferAsyncEnd(input: {
  EndT: EndCtor;
  srcInst: ComponentInstanceState;
  dstInst: ComponentInstanceState;
  srcElem: ValType | null;
  dstElem: ValType | null;
  srcIdx: number;
  what: string;
}): number {
  const { EndT, srcInst, dstInst, srcElem, dstElem, srcIdx, what } = input;
  const e = srcInst.handles.remove(srcIdx);
  trapIf(!(e instanceof EndT), `${what}: handle is not a readable ${what} end`);
  const end = e as CopyEnd;
  trapIf(!sameElem(end.shared.t, srcElem), `${what}: source element mismatch`);
  trapIf(!sameElem(end.shared.t, dstElem), `${what}: destination element mismatch`);
  // definitions.py `lift_async_value`: an end that is mid-copy or parked in a
  // waitable set cannot be handed on. The messages match the suite's
  // `assert_trap` text.
  trapIf(
    end.state === CopyState.DONE,
    what === "future"
      ? "cannot lift future after previous read succeeded"
      : "cannot lift stream after being notified that the writable end dropped",
  );
  trapIf(
    end.state !== CopyState.IDLE,
    `cannot remove busy ${what}`,
  );
  trapIf(
    end.inWaitableSet(),
    `cannot lift ${what} while it's in a waitable set`,
  );
  const Ctor = EndT as unknown as new (shared: unknown) => CopyEnd;
  return dstInst.handles.add(new Ctor(end.shared));
}

export function createStreamTransfer(ctx: AsyncTransferContext): CoreFn {
  return (srcIdx?: number, srcTable?: number, dstTable?: number) =>
    transferAsyncEnd({
      EndT: ReadableStreamEnd as unknown as EndCtor,
      srcInst: ctx.streamTableInstance(srcTable ?? 0),
      dstInst: ctx.streamTableInstance(dstTable ?? 0),
      srcElem: ctx.streamElem(srcTable ?? 0),
      dstElem: ctx.streamElem(dstTable ?? 0),
      srcIdx: srcIdx ?? 0,
      what: "stream",
    });
}

export function createFutureTransfer(ctx: AsyncTransferContext): CoreFn {
  return (srcIdx?: number, srcTable?: number, dstTable?: number) =>
    transferAsyncEnd({
      EndT: ReadableFutureEnd as unknown as EndCtor,
      srcInst: ctx.futureTableInstance(srcTable ?? 0),
      dstInst: ctx.futureTableInstance(dstTable ?? 0),
      srcElem: ctx.futureElem(srcTable ?? 0),
      dstElem: ctx.futureElem(dstTable ?? 0),
      srcIdx: srcIdx ?? 0,
      what: "future",
    });
}

/**
 * error-context transfer. Unlike stream/future ends, an `error-context` is
 * shareable: `lift_error_context` (definitions.py line 1451) *reads* the handle
 * rather than removing it, so the source keeps its own.
 */
/**
 * CONTRACT: the plan has no `errorContextTables` section, so the table indices
 * this intrinsic receives are resolved through the *resource*-table instance
 * mapping. That happens to agree for the current corpus and fails loudly
 * (`PlanError`) when it does not, but it is an assumption, not a guarantee —
 * an `errorContextTables` field (alongside the v2 `streamTables`/
 * `futureTables`) would make it exact. Recorded with the other plan-format
 * friction items.
 */
export function createErrorContextTransfer(
  ctx: AsyncTransferContext,
  instanceOf: (table: number) => ComponentInstanceState,
): CoreFn {
  void ctx;
  return (srcIdx?: number, srcTable?: number, dstTable?: number) => {
    const srcInst = instanceOf(srcTable ?? 0);
    const dstInst = instanceOf(dstTable ?? 0);
    const e = srcInst.handles.get(srcIdx ?? 0);
    trapIf(
      !(e instanceof ErrorContext),
      "error-context transfer: handle is not an error-context",
    );
    return dstInst.handles.add(e as ErrorContext);
  };
}
