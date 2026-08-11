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

import { defineBrand, ERROR_CONTEXT } from "@deltic/protocol";
import { assert_, trapIf } from "../cabi/trap.ts";
import { LiftLowerContext } from "../cabi/context.ts";
import { loadListFromValidRange } from "../cabi/load.ts";
import { storeListIntoValidRange } from "../cabi/store.ts";
import { alignment, alignTo, elemSize } from "../cabi/layout.ts";
import { despecialize, valTypeEqual } from "../cabi/types.ts";
import type { ComponentValue, ValType } from "../cabi/types.ts";
import { Waitable } from "./waitable.ts";
import { setOnInstancePoisoned } from "./scheduler.ts";

/** Structural element-type equality (`null` = the zero-width payload).
 * Delegates to `valTypeEqual`: naive `JSON.stringify` comparison throws on
 * resource-bearing element types (cabi/types.ts `valTypeEqual` contract
 * note; found by the #18 polymorph-tls smoke). */
export function sameElemType(a: ValType | null, b: ValType | null): boolean {
  if (a === null || b === null) return a === b;
  return valTypeEqual(a, b);
}

/** definitions.py `Buffer.MAX_LENGTH`. */
export const BUFFER_MAX_LENGTH = 2 ** 28 - 1;

/**
 * One rendezvous chunk. u8 payloads travel as `Uint8Array` — the lift out of
 * guest memory and the conventions layer's lowering both produce typed
 * chunks, and every buffer in the copy path keeps them whole (issue #54: the
 * typed shape is what makes both the guest-memory store and a host→host
 * hand-off bulk). Every other element type travels as a plain array.
 */
export type PayloadChunk = ComponentValue[] | Uint8Array;

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
  read(n: number): PayloadChunk {
    assert_(n <= this.remain(), "buffer read beyond remaining");
    let vs: PayloadChunk;
    if (this.t !== null) {
      vs = loadListFromValidRange(this.cx, this.ptr, n, this.t) as PayloadChunk;
      this.ptr += n * elemSize(this.t, this.cx.opts.memory!.ptrType());
    } else {
      vs = new Array(n).fill(null);
    }
    this.progress += n;
    return vs;
  }

  /** definitions.py `WritableBufferGuestImpl.write`. */
  write(vs: PayloadChunk): void {
    assert_(vs.length <= this.remain(), "buffer write beyond remaining");
    if (this.t !== null) {
      storeListIntoValidRange(this.cx, vs, this.ptr, this.t);
      this.ptr += vs.length * elemSize(this.t, this.cx.opts.memory!.ptrType());
    } else {
      // definitions.py `WritableBufferGuestImpl.write`:
      // `assert(all(v == () for v in vs))` — a zero-width stream carries no
      // payload, so anything but the placeholder means a element-type mix-up
      // upstream (a typed chunk here would be the same mix-up).
      assert_(
        !(vs instanceof Uint8Array) && vs.every((v) => v === null),
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
  /**
   * Optional hook fired when this shared object is lowered into a component
   * instance (`lower_stream`/`lower_future`). Host-owned ends use it to learn
   * which `Store` is driving the guest they were just handed to; guest-owned
   * streams leave it unset. Keeps `cabi` free of any host-stream knowledge.
   */
  onLowered: ((inst: { store: unknown }) => void) | null = null;
  /**
   * The `Store` driving the component this object has been handed to, set the
   * first time it is lifted or lowered. Host ends need it to pump the guest
   * between export calls (see exec/host_streams.ts `HostActivity.pump`); a
   * purely guest-to-guest stream never reads it.
   */
  boundStore: unknown = null;

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
      } else if (
        srcBuffer.isZeroLength() && this.pendingBuffer.isZeroLength()
      ) {
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
  /**
   * Optional hook fired when this shared object is lowered into a component
   * instance (`lower_stream`/`lower_future`). Host-owned ends use it to learn
   * which `Store` is driving the guest they were just handed to; guest-owned
   * streams leave it unset. Keeps `cabi` free of any host-stream knowledge.
   */
  onLowered: ((inst: { store: unknown }) => void) | null = null;
  /**
   * The `Store` driving the component this object has been handed to, set the
   * first time it is lifted or lowered. Host ends need it to pump the guest
   * between export calls (see exec/host_streams.ts `HostActivity.pump`); a
   * purely guest-to-guest stream never reads it.
   */
  boundStore: unknown = null;

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
// Poisoned-instance retirement (#66)
// ---------------------------------------------------------------------------

/**
 * Failures recorded against shared stream/future objects whose peer end died
 * inside a trap-poisoned instance's handle table. The embedder layer consults
 * this to reject host operations loudly (contracts/embedder-api.md amendment
 * A7) instead of letting them hang forever or fake a clean end-of-stream.
 */
const poisonFailures = new WeakMap<object, Error>();

/** The recorded poisoning failure for a shared stream/future value, if any. */
export function poisonFailureOf(shared: unknown): Error | undefined {
  return typeof shared === "object" && shared !== null
    ? poisonFailures.get(shared)
    : undefined;
}

/** Instances whose async ends have already been retired (idempotence). */
const retiredInstances = new WeakSet<object>();

/** The structural slice of `ComponentInstanceState` the walk needs. */
interface PoisonedInstanceLike {
  readonly index?: number;
  handles: Iterable<unknown>;
}

/**
 * Drop a shared stream/future as *teardown*, without waking a doomed guest.
 *
 * Same outcome as `drop()` for host ends and healthy guest peers (a DROPPED
 * notification), with one difference: a parked side belonging to an entered
 * — and on every teardown path, about-to-be- or already-poisoned — guest
 * instance (`mayEnter === false`) is retired silently via `resetPending`.
 * Notifying it would queue a phantom event into the corpse's waitables, and
 * a later driving loop servicing it would resume machinery whose instance
 * can no longer be entered (`tick` asserts enterability). Host sentinels
 * carry no `mayEnter` key and healthy guest peers park only outside the
 * bracket (`mayEnter === true`), so both are always notified.
 *
 * Used by the poisoning walk below and by the trapping-import abandonment
 * path (embedder/instantiate.ts `releaseAsyncArgs`). Idempotent.
 */
export function dropSharedForTeardown(
  shared: SharedStreamImpl | SharedFutureImpl,
): void {
  if (shared.dropped) return;
  shared.dropped = true;
  if (shared.pendingBuffer) {
    const pi = shared.pendingInst as { mayEnter?: boolean } | null;
    const parkedInDeadGuest = pi !== null && typeof pi === "object" &&
      typeof pi.mayEnter === "boolean" && !pi.mayEnter;
    if (parkedInDeadGuest) shared.resetPending();
    else shared.resetAndNotifyPending(CopyResult.DROPPED);
  }
}

/**
 * Retire every live stream/future end in a trap-poisoned instance's handle
 * table (#66).
 *
 * Rationale: after a trap breaks the enter/leave bracket, `mayEnter` stays
 * false forever, so no task of this instance can ever rendezvous again. Its
 * table's `CopyEnd`s are therefore unreachable-forever — leaving their shared
 * objects live strands the peers: a parked HOST operation never settles (its
 * promise hangs), and a LATER host operation would "succeed" against the
 * corpse (a copy into memory nothing will ever read — silent data loss).
 * Dropping the shared object now converts both into the spec-shaped DROPPED
 * outcome, and the recorded failure lets the embedder layer brand it.
 *
 * Called from every bracket-break site — exec/boundary.ts `poison()` (the
 * sync-lift path), scheduler.ts `Store.tick` and thread.ts
 * `Thread.resumeWith` (traps during a resumed thread), and the FACT
 * cross-component catches (intrinsics/fact_calls.ts, callee side) — with the
 * trap as `cause`. Idempotent per instance. The parked-side notification
 * discipline lives in `dropSharedForTeardown` above.
 */
export function retireInstanceAsyncEnds(
  inst: PoisonedInstanceLike,
  cause: unknown,
): void {
  if (retiredInstances.has(inst)) return;
  retiredInstances.add(inst);
  for (const e of inst.handles) {
    if (!(e instanceof CopyEnd)) continue;
    const shared = e.shared as SharedStreamImpl | SharedFutureImpl;
    if (poisonFailures.get(shared) === undefined) {
      const where = inst.index !== undefined
        ? `component instance ${inst.index}`
        : "a component instance";
      poisonFailures.set(
        shared,
        new Error(
          `${where} trapped while it held an end of this stream/future; ` +
            `the peer can never rendezvous again`,
          { cause },
        ),
      );
    }
    dropSharedForTeardown(shared);
  }
}

// `Store.tick`'s bracket-break site reaches the walk through this seam (its
// module cannot import ours — see `setOnInstancePoisoned`); the sync-lift
// site (exec/boundary.ts `poison`) imports it directly.
setOnInstancePoisoned(retireInstanceAsyncEnds);

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
// A8 brand (contracts/embedder-api.md §"Module identity"): error-contexts are
// STATEFUL — they live in a component instance's handle table — so the brand
// exists to make a foreign one diagnosable at the lowering sites, never
// usable. Both this internal class and the embedder-facing wrapper
// (embedder/streams.ts) carry it, because either shape can be handed back to
// a lowering site by embedder code.
defineBrand(ErrorContext.prototype, ERROR_CONTEXT);
