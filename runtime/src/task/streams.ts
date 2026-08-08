// Streams, futures and error-context: the async *value* types
// (definitions.py `### Stream State`, `### Future State`, `class ErrorContext`).
//
// ===========================================================================
// THE RENDEZVOUS, AND HOW IT MAPS ONTO OUR TASK CORE
// ===========================================================================
//
// A stream is not a buffer. `SharedStreamImpl` (definitions.py line 997) holds
// at most **one pending side** — a reader waiting for data, or a writer
// waiting for a reader — and a copy happens only when the second side arrives.
// That is the whole model:
//
//   * first side to call `read`/`write` finds `pending_buffer == None` and
//     parks itself via `set_pending(...)`;
//   * second side finds a pending buffer, copies `min(remain, remain)`
//     elements directly between the two guests' linear memories, and notifies
//     *both* sides;
//   * either side may be partially satisfied — that is not an error, it is the
//     normal case, and the progress count is what the guest is told.
//
// Nothing here needs a scheduler: the copy is synchronous inside whichever
// call arrives second. What the scheduler provides is the *waiting*: a parked
// side has `CopyState.COPYING` and its `CopyEnd` (a `Waitable`) carries the
// pending event that wakes the guest.
//
// So the mapping to our task core is small and mechanical:
//
//   reference                    here
//   ------------------------------------------------------------------
//   CopyEnd(Waitable)            CopyEnd extends our Waitable — the same
//                                base the SUBTASK path already uses, so
//                                waitable sets, `waitable.join` and the
//                                callback loop's WAIT code all work unchanged
//   set_pending_event(thunk)     the same thunk indirection: the event payload
//                                (progress, result) is computed at *delivery*
//                                time, exactly as `Subtask.setSubtaskPendingEvent`
//                                already does. This is why the phase-1 decision
//                                to keep events as thunks rather than values
//                                pays off here with no generalization at all.
//   STREAM_READ / STREAM_WRITE   EventCode values, already defined
//   FUTURE_READ / FUTURE_WRITE
//
// The one genuinely new thing is `Buffer`: a cursor over a guest's linear
// memory that can be *partially* consumed, which is what makes partial copies
// expressible.

import { assert_, trapIf } from "../cabi/trap.ts";
import { LiftLowerContext } from "../cabi/context.ts";
import { loadListFromValidRange } from "../cabi/load.ts";
import { storeListIntoValidRange } from "../cabi/store.ts";
import { alignTo, alignment, elemSize } from "../cabi/layout.ts";
import { despecialize } from "../cabi/types.ts";
import type { ComponentValue, ValType } from "../cabi/types.ts";
import { Waitable } from "./waitable.ts";

/** Structural element-type equality (`null` = the zero-width payload). */
export function sameElemType(a: ValType | null, b: ValType | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** definitions.py `Buffer.MAX_LENGTH`. */
export const BUFFER_MAX_LENGTH = 2 ** 28 - 1;

/** definitions.py `CopyResult` (line 977). */
export enum CopyResult {
  COMPLETED = 0,
  DROPPED = 1,
  CANCELLED = 2,
}

/** definitions.py `CopyState` (line 1075). */
export enum CopyState {
  IDLE = 1,
  COPYING = 2,
  CANCELLING_COPY = 3,
  DONE = 4,
}

export type ReclaimBuffer = () => void;
export type OnCopy = (reclaim: ReclaimBuffer) => void;
export type OnCopyDone = (result: CopyResult) => void;

// ---------------------------------------------------------------------------
// Buffers (definitions.py `class BufferGuestImpl`, line 930)
// ---------------------------------------------------------------------------

/**
 * A cursor over `length` elements of type `t` at `ptr` in one guest's memory.
 * `t === null` is the zero-width element type (`stream` with no payload),
 * where only the *count* is meaningful.
 */
export class GuestBuffer {
  progress = 0;

  constructor(
    readonly t: ValType | null,
    readonly cx: LiftLowerContext,
    public ptr: number,
    readonly length: number,
  ) {
    trapIf(length > BUFFER_MAX_LENGTH, "buffer length exceeds MAX_LENGTH");
    if (t !== null && length > 0) {
      const mem = cx.opts.memory;
      assert_(mem !== null, "buffer requires a memory");
      const ptrType = mem.ptrType();
      trapIf(
        ptr !== alignTo(ptr, alignment(t, ptrType)),
        "unaligned buffer pointer",
      );
      trapIf(
        ptr + length * elemSize(t, ptrType) > mem.length,
        "buffer out of bounds",
      );
    }
  }

  remain(): number {
    return this.length - this.progress;
  }

  isZeroLength(): boolean {
    return this.length === 0;
  }

  /** definitions.py `ReadableBufferGuestImpl.read`. */
  read(n: number): ComponentValue[] {
    assert_(n <= this.remain(), "buffer read beyond remaining");
    let vs: ComponentValue[];
    if (this.t !== null) {
      vs = loadListFromValidRange(this.cx, this.ptr, n, this.t) as ComponentValue[];
      this.ptr += n * elemSize(this.t, this.cx.opts.memory!.ptrType());
    } else {
      vs = new Array(n).fill(null);
    }
    this.progress += n;
    return vs;
  }

  /** definitions.py `WritableBufferGuestImpl.write`. */
  write(vs: ComponentValue[]): void {
    assert_(vs.length <= this.remain(), "buffer write beyond remaining");
    if (this.t !== null) {
      storeListIntoValidRange(this.cx, vs, this.ptr, this.t);
      this.ptr += vs.length * elemSize(this.t, this.cx.opts.memory!.ptrType());
    } else {
      // definitions.py `WritableBufferGuestImpl.write`:
      // `assert(all(v == () for v in vs))` — a zero-width stream carries no
      // payload, so anything but the placeholder means a element-type mix-up
      // upstream.
      assert_(
        vs.every((v) => v === null),
        "zero-width buffer written with a non-empty element",
      );
    }
    this.progress += vs.length;
  }
}

/**
 * definitions.py `none_or_number_type` (line 1070). Guards the "temporary"
 * same-instance restriction below.
 */
function noneOrNumberType(t: ValType | null): boolean {
  if (t === null) return true;
  switch (despecialize(t).kind) {
    case "u8":
    case "u16":
    case "u32":
    case "u64":
    case "s8":
    case "s16":
    case "s32":
    case "s64":
    case "f32":
    case "f64":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The shared stream (definitions.py `class SharedStreamImpl`, line 997)
// ---------------------------------------------------------------------------

/** Common shape of the object a `stream`/`future` *value* refers to. */
export interface SharedBase {
  readonly t: ValType | null;
  dropped: boolean;
  cancel(): void;
  drop(): void;
}

export class SharedStreamImpl implements SharedBase {
  dropped = false;
  pendingInst: unknown = null;
  pendingBuffer: GuestBuffer | null = null;
  pendingOnCopy: OnCopy | null = null;
  pendingOnCopyDone: OnCopyDone | null = null;

  constructor(readonly t: ValType | null) {}

  resetPending(): void {
    this.setPending(null, null, null, null);
  }

  setPending(
    inst: unknown,
    buffer: GuestBuffer | null,
    onCopy: OnCopy | null,
    onCopyDone: OnCopyDone | null,
  ): void {
    this.pendingInst = inst;
    this.pendingBuffer = buffer;
    this.pendingOnCopy = onCopy;
    this.pendingOnCopyDone = onCopyDone;
  }

  resetAndNotifyPending(result: CopyResult): void {
    const done = this.pendingOnCopyDone;
    assert_(done !== null, "reset_and_notify_pending with nothing pending");
    this.resetPending();
    done!(result);
  }

  cancel(): void {
    this.resetAndNotifyPending(CopyResult.CANCELLED);
  }

  drop(): void {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) this.resetAndNotifyPending(CopyResult.DROPPED);
    }
  }

  /** definitions.py `SharedStreamImpl.read` (line 1032). */
  read(
    inst: unknown,
    dstBuffer: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, dstBuffer, onCopy, onCopyDone);
    } else {
      this.#assertSameElemType(dstBuffer);
      this.#trapOnSameInstance(inst);
      if (this.pendingBuffer.remain() > 0) {
        if (dstBuffer.remain() > 0) {
          const n = Math.min(dstBuffer.remain(), this.pendingBuffer.remain());
          dstBuffer.write(this.pendingBuffer.read(n));
          this.pendingOnCopy!(() => this.resetPending());
        }
        onCopyDone(CopyResult.COMPLETED);
      } else {
        // The parked writer had nothing left: retire it and park the reader.
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.setPending(inst, dstBuffer, onCopy, onCopyDone);
      }
    }
  }

  /** definitions.py `SharedStreamImpl.write` (line 1050). */
  write(
    inst: unknown,
    srcBuffer: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, srcBuffer, onCopy, onCopyDone);
    } else {
      this.#assertSameElemType(srcBuffer);
      this.#trapOnSameInstance(inst);
      if (this.pendingBuffer.remain() > 0) {
        if (srcBuffer.remain() > 0) {
          const n = Math.min(srcBuffer.remain(), this.pendingBuffer.remain());
          this.pendingBuffer.write(srcBuffer.read(n));
          this.pendingOnCopy!(() => this.resetPending());
        }
        onCopyDone(CopyResult.COMPLETED);
      } else if (srcBuffer.isZeroLength() && this.pendingBuffer.isZeroLength()) {
        // Zero-length rendezvous: both sides are empty, which is a *completed*
        // handshake rather than a parked write (definitions.py line 1064 —
        // the case `test/async/zero-length.wast` exists to pin).
        onCopyDone(CopyResult.COMPLETED);
      } else {
        this.resetAndNotifyPending(CopyResult.COMPLETED);
        this.setPending(inst, srcBuffer, onCopy, onCopyDone);
      }
    }
  }

  #assertSameElemType(b: GuestBuffer): void {
    // Structural, not identity: definitions.py compares dataclass types with
    // `==`, and our `ValType`s are fresh objects per table (the plan's type
    // table is converted per instantiation), so identity would reject every
    // legitimate cross-instance stream.
    assert_(
      sameElemType(this.t, b.t) && sameElemType(b.t, this.pendingBuffer!.t),
      "stream element type mismatch between ends",
    );
  }

  /**
   * definitions.py marks this `# temporary`: a same-instance copy of a
   * non-number element type would need the source and destination lifts to
   * interleave, which the reference has not specified yet.
   */
  #trapOnSameInstance(inst: unknown): void {
    trapIf(
      inst === this.pendingInst && !noneOrNumberType(this.t),
      "cannot read from and write to intra-component stream",
    );
  }
}

/** definitions.py `class SharedFutureImpl` (line 1119). Exactly one element. */
export class SharedFutureImpl implements SharedBase {
  dropped = false;
  pendingInst: unknown = null;
  pendingBuffer: GuestBuffer | null = null;
  pendingOnCopyDone: OnCopyDone | null = null;

  constructor(readonly t: ValType | null) {}

  resetPending(): void {
    this.setPending(null, null, null);
  }

  setPending(
    inst: unknown,
    buffer: GuestBuffer | null,
    onCopyDone: OnCopyDone | null,
  ): void {
    this.pendingInst = inst;
    this.pendingBuffer = buffer;
    this.pendingOnCopyDone = onCopyDone;
  }

  resetAndNotifyPending(result: CopyResult): void {
    const done = this.pendingOnCopyDone;
    assert_(done !== null, "reset_and_notify_pending with nothing pending");
    this.resetPending();
    done!(result);
  }

  cancel(): void {
    this.resetAndNotifyPending(CopyResult.CANCELLED);
  }

  drop(): void {
    if (!this.dropped) {
      this.dropped = true;
      if (this.pendingBuffer) this.resetAndNotifyPending(CopyResult.DROPPED);
    }
  }

  read(inst: unknown, dstBuffer: GuestBuffer, onCopyDone: OnCopyDone): void {
    assert_(!this.dropped && dstBuffer.remain() === 1, "future read shape");
    if (!this.pendingBuffer) {
      this.setPending(inst, dstBuffer, onCopyDone);
    } else {
      trapIf(
        inst === this.pendingInst && !noneOrNumberType(this.t),
        "cannot read from and write to intra-component future",
      );
      dstBuffer.write(this.pendingBuffer.read(1));
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }

  write(inst: unknown, srcBuffer: GuestBuffer, onCopyDone: OnCopyDone): void {
    assert_(srcBuffer.remain() === 1, "future write shape");
    if (this.dropped) {
      onCopyDone(CopyResult.DROPPED);
    } else if (!this.pendingBuffer) {
      this.setPending(inst, srcBuffer, onCopyDone);
    } else {
      trapIf(
        inst === this.pendingInst && !noneOrNumberType(this.t),
        "cannot read from and write to intra-component future",
      );
      this.pendingBuffer.write(srcBuffer.read(1));
      this.resetAndNotifyPending(CopyResult.COMPLETED);
      onCopyDone(CopyResult.COMPLETED);
    }
  }
}

// ---------------------------------------------------------------------------
// Copy ends (definitions.py `class CopyEnd`, line 1081)
// ---------------------------------------------------------------------------

/**
 * One guest-visible end of a stream or future. It **is** a `Waitable`, so it
 * joins waitable sets and delivers events through the machinery the subtask
 * path already uses.
 */
export abstract class CopyEnd extends Waitable {
  state: CopyState = CopyState.IDLE;

  constructor(readonly shared: SharedBase) {
    super();
  }

  copying(): boolean {
    return this.state === CopyState.COPYING ||
      this.state === CopyState.CANCELLING_COPY;
  }

  override drop(): void {
    trapIf(this.copying(), "cannot drop busy stream");
    this.shared.drop();
    super.drop();
  }
}

export class ReadableStreamEnd extends CopyEnd {
  declare readonly shared: SharedStreamImpl;
  copy(
    inst: unknown,
    dst: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    this.shared.read(inst, dst, onCopy, onCopyDone);
  }
}

export class WritableStreamEnd extends CopyEnd {
  declare readonly shared: SharedStreamImpl;
  copy(
    inst: unknown,
    src: GuestBuffer,
    onCopy: OnCopy,
    onCopyDone: OnCopyDone,
  ): void {
    this.shared.write(inst, src, onCopy, onCopyDone);
  }
}

export class ReadableFutureEnd extends CopyEnd {
  declare readonly shared: SharedFutureImpl;
  copy(inst: unknown, dst: GuestBuffer, onCopyDone: OnCopyDone): void {
    this.shared.read(inst, dst, onCopyDone);
  }
}

export class WritableFutureEnd extends CopyEnd {
  declare readonly shared: SharedFutureImpl;
  copy(inst: unknown, src: GuestBuffer, onCopyDone: OnCopyDone): void {
    this.shared.write(inst, src, onCopyDone);
  }

  /**
   * definitions.py `WritableFutureEnd.drop` (line 1183): a future's writable
   * end may only be dropped once it has actually delivered its one value —
   * `test/async/futures-must-write.wast` is the case this exists for.
   */
  override drop(): void {
    trapIf(
      this.state !== CopyState.DONE,
      "cannot drop future write end without first writing a value",
    );
    super.drop();
  }
}

// ---------------------------------------------------------------------------
// error-context (definitions.py `class ErrorContext`, line 2782)
// ---------------------------------------------------------------------------

/**
 * definitions.py models the debug message as a `String` triple; we keep the
 * decoded JS string plus its encoding, which is all `store_string` needs.
 */
export class ErrorContext {
  constructor(readonly debugMessage: string) {}
}
