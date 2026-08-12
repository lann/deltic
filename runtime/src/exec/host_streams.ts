// Host-side stream and future ends: the minimal embedder surface for the
// async value types.
//
// ===========================================================================
// WHY THIS IS SMALL
// ===========================================================================
//
// The rendezvous in `task/streams.ts` never touches linear memory. It only
// ever calls four methods on whatever buffer it is handed — `read`, `write`,
// `remain`, `isZeroLength` — and it passes the *shared* stream object around
// by identity. So a host end needs exactly two new things:
//
//   * `HostBuffer`, a sibling of `GuestBuffer` implementing that same
//     four-method surface over a plain JS array instead of guest memory; and
//   * a way to park a host read/write until the guest shows up.
//
// Everything else is existing machinery. In particular the *value* that
// crosses the component boundary is the `SharedStreamImpl` itself, so passing
// a host stream to a guest goes through the ordinary `lowerStream` path
// (definitions.py `lower_stream`, line 1828 — wrap the shared object in a
// fresh `ReadableStreamEnd` in the callee's table) and a guest-returned stream
// arrives as the same kind of object from `liftStream`. No lift/lower code was
// added for this file.
//
// ===========================================================================
// SCHEDULING
// ===========================================================================
//
// A host read/write that cannot rendezvous immediately parks, exactly as a
// guest one does, and hands back a Promise. Two cases:
//
//   * The guest is still running (it is what will complete the rendezvous).
//     The host's `onCopyDone` fires synchronously inside the guest's
//     `stream.read`/`stream.write` trampoline and the Promise resolves.
//   * The *guest* is the parked side and only the embedder can make progress.
//     Then `drive()` would otherwise see no ready thread and no outstanding
//     host call and declare deadlock — correctly, for a component that really
//     is stuck, but wrongly here. `HostActivity` below registers a
//     re-arming promise in `store.pendingHostCalls` for as long as a host end
//     is live, which is precisely the signal `driveAsync` already understands:
//     "progress is possible, but only after a turn of the event loop".
//
// The consequence, stated plainly: an embedder that lowers a host stream into
// a guest and then never writes to it or drops it will *hang* rather than
// trap. That is the honest outcome — the component is not deadlocked, the
// embedder simply has not done its half — and it matches how any other
// unresolved Promise behaves in JS.
//
// The inverse case is NOT a hang (#66, embedder-api amendment A7): when the
// GUEST side dies — a trap poisons the instance holding the peer end — the
// poisoned table's ends are retired (task/streams.ts
// `retireInstanceAsyncEnds`), so a parked host operation settles DROPPED-
// shaped here and the conventions layer rejects it with `PeerTrappedError`.
// Only embedder negligence hangs; a component fault is always loud.

import { assert_ } from "../cabi/trap.ts";
import { despecialize } from "../cabi/types.ts";
import type { ComponentValue, ValType } from "../cabi/types.ts";
import {
  driveStoreAsync,
  storeDriverDepth,
  whenStoreDriverIdle,
} from "./boundary.ts";
import {
  abandonSharedFuture,
  BUFFER_MAX_LENGTH,
  type ComponentInstanceState,
  CopyResult,
  markHostActivityArm,
  type PayloadChunk,
  sameElemType,
  SharedFutureImpl,
  SharedStreamImpl,
  type Store,
  storeQuiescent as quiescent,
} from "../task/mod.ts";

/**
 * The `inst` a host end presents to the rendezvous. definitions.py compares it
 * against `pending_inst` for the "same instance" restriction — a guard against
 * interleaving two *lifts in one component instance's linear memory*, which is
 * why it exempts number types (definitions.py `none_or_number_type`). A host
 * end has no linear memory, so that restriction can never apply to it: each
 * end gets its OWN sentinel (never equal to a real `ComponentInstanceState`,
 * and never equal to the peer end's), so a host writer and a host reader may
 * rendezvous directly for every element type. One shared sentinel used to
 * stand for "the host" here, which made a post-pass-through host↔host copy of
 * a non-number element type trap as "intra-component" (found by the #54
 * pass-through investigation).
 */
function hostEndInstance(role: "read" | "write"): unknown {
  return Object.freeze({ hostEnd: role });
}

/**
 * A buffer over JS values. Sibling of `GuestBuffer`, same four methods, no
 * memory access. Used in one of two directions:
 *
 *   * as a *readable* buffer (host supplies `values`, the guest reads them);
 *   * as a *writable* buffer (host supplies capacity, the guest fills it and
 *     `taken()` is what arrived).
 *
 * u8 payloads stay `Uint8Array` through both directions (issue #54): `read`
 * slices the typed array (bulk, and the ONE semantically required copy — the
 * chunk is only borrowed by the stream until the write settles, so the reader
 * must receive owned bytes), and `write` keeps arriving chunks whole instead
 * of exploding them element-by-element into a plain array.
 */
export class HostBuffer {
  progress = 0;
  #chunks: PayloadChunk[] = [];

  constructor(
    readonly t: ValType | null,
    private readonly values: PayloadChunk | null,
    readonly length: number,
  ) {
    // definitions.py `Buffer.MAX_LENGTH` (:919) is asserted on every buffer
    // the spec builds (`BufferGuestImpl.__init__`, :938); `GuestBuffer` traps
    // on it. A host buffer is not guest-visible, so a violation is embedder
    // misuse rather than a component fault — hence a loud typed JS error and
    // not a `Trap`. Caught at construction: an over-long host offer would
    // otherwise silently exceed the spec bound (#97).
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError(
        `host buffer length must be a non-negative integer, got ${length}`,
      );
    }
    if (length > BUFFER_MAX_LENGTH) {
      throw new RangeError(
        `host buffer length ${length} exceeds the Component Model's ` +
          `Buffer.MAX_LENGTH (${BUFFER_MAX_LENGTH})`,
      );
    }
  }

  remain(): number {
    return this.length - this.progress;
  }

  isZeroLength(): boolean {
    return this.length === 0;
  }

  /** Guest side is reading from us. */
  read(n: number): PayloadChunk {
    assert_(n <= this.remain(), "host buffer read beyond remaining");
    const out = this.values === null
      ? new Array(n).fill(null)
      : this.values.slice(this.progress, this.progress + n);
    this.progress += n;
    return out as PayloadChunk;
  }

  /** Guest side is writing into us. */
  write(vs: PayloadChunk): void {
    assert_(vs.length <= this.remain(), "host buffer write beyond remaining");
    this.#chunks.push(vs);
    this.progress += vs.length;
  }

  /**
   * Everything written into this buffer, in arrival order.
   *
   * For a u8 element type the result is a `Uint8Array`; in the common case —
   * one rendezvous before the read resolves — the writer's chunk is returned
   * as-is, so the whole host-side read costs exactly the one rendezvous copy.
   * Every other element type yields a plain array regardless of the shape the
   * writer used.
   */
  taken(): PayloadChunk {
    const u8 = this.t !== null && despecialize(this.t).kind === "u8";
    if (u8) {
      if (this.#chunks.length === 1 && this.#chunks[0] instanceof Uint8Array) {
        return this.#chunks[0];
      }
      // Multiple chunks, or a raw-layer plain-array writer: pack. Element
      // coercion matches Uint8Array.from, which is what the conventions
      // layer applied to these values before chunks stayed whole.
      const out = new Uint8Array(this.progress);
      let o = 0;
      for (const c of this.#chunks) {
        if (c instanceof Uint8Array) out.set(c, o);
        else for (let i = 0; i < c.length; i++) out[o + i] = c[i] as number;
        o += c.length;
      }
      return out;
    }
    if (this.#chunks.length === 1 && Array.isArray(this.#chunks[0])) {
      return this.#chunks[0];
    }
    const out: ComponentValue[] = [];
    for (const c of this.#chunks) {
      for (let i = 0; i < c.length; i++) out.push(c[i]);
    }
    return out;
  }
}

/**
 * Every live `HostActivity` arm, by identity. These are the promises this
 * module parks in `store.pendingHostCalls` purely to say "the embedder may
 * still act"; they are NOT outstanding work, so the host pump must not treat
 * their presence as a reason to keep looping (that is the "activity keeps
 * pendingHostCalls non-empty forever" hazard: a pump whose exit condition is
 * `pendingHostCalls.size === 0` would never exit).
 *
 * The registry and the two predicates over it (`hasRealHostCall`,
 * `storeQuiescent`, imported above as `quiescent`) moved to
 * task/scheduler.ts so that boundary.ts's settlement pump — the OTHER
 * between-calls driver — shares the same classification without an import
 * cycle. Arms are minted here and marked via `markHostActivityArm`.
 */

/**
 * Keeps `store.pendingHostCalls` non-empty while a host end is live, so the
 * driving loop treats "waiting for the embedder" as progress-is-possible
 * rather than deadlock. Re-arms after every notification.
 */
class HostActivity {
  #store: Store | null = null;
  #promise: Promise<void> | null = null;
  #resolve: (() => void) | null = null;
  #closed = false;
  #pumping = false;

  bind(store: Store): void {
    if (this.#store !== null || this.#closed) return;
    this.#store = store;
    this.#arm();
  }

  #arm(): void {
    if (this.#store === null || this.#promise !== null || this.#closed) return;
    this.#promise = new Promise<void>((r) => (this.#resolve = r));
    markHostActivityArm(this.#promise);
    this.#store.pendingHostCalls.add(this.#promise);
  }

  /** The embedder did something; let the driving loop re-pump. */
  notify(): void {
    const p = this.#promise, r = this.#resolve;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) {
      this.#store.pendingHostCalls.delete(p);
    }
    r?.();
    this.#arm();
  }

  /**
   * Drive the guest until it can make no more progress.
   *
   * A host operation that lands *between* export calls has no driving loop
   * running — `drive()` returned when the last export call resolved. So after
   * initiating a host read/write (or a drop) we pump the store ourselves.
   * Synchronously first (the common case: the guest is merely waiting on a
   * scheduler condition our rendezvous just satisfied, and the host op's
   * promise resolves before we return), then — if anything is still
   * outstanding — by handing the store to the *same* loop an export call
   * would have used, `driveStoreAsync`. Without the asynchronous half a guest
   * parked in a background forwarding task would never be resumed to consume
   * what we just offered, and the host read would await forever (C0 finding
   * R-1: the previous local drain only serviced `store.awaiting` and never
   * awaited `store.pendingHostCalls`, so a writer parked on a
   * Promise-returning host import stalled the reader).
   *
   * Traps from the synchronous half propagate to the caller of the host
   * operation, which is the only place that can report them.
   */
  pump(): void {
    const store = this.#store;
    if (store === null) return;
    // Settled activation tails gate `tick` (Store.settled); a driver that
    // never services them wedges the store — this loop runs BETWEEN export
    // calls, when no driveAsync exists to do it.
    for (;;) {
      const serviced = store.serviceSettled();
      const ticked = store.tick();
      if (!serviced && !ticked) break;
    }
    if (this.#pumping) return;
    // Nothing is outstanding that only an event-loop turn could advance ⇒ no
    // asynchronous pump needed. In particular an embedder that lowered a host
    // end into a guest and then never did its half lands here: we return, no
    // spin and no deadlock trap, and the operation's promise simply stays
    // pending — the documented "hangs rather than traps" behaviour (see the
    // module header).
    if (quiescent(store)) return;
    this.#pumping = true;
    void this.#pumpAsync(store);
  }

  async #pumpAsync(store: Store): Promise<void> {
    try {
      // This pump is the FALLBACK driver — the one for host operations that
      // land BETWEEN export calls — so it stands down whenever an export
      // call's loop is live: that loop already races `pendingHostCalls` and
      // `store.awaiting` and so pumps host activity on our behalf. When it
      // exits, we take over. `whenStoreDriverIdle` is edge-triggered, not
      // polled, so waiting costs no turns.
      //
      // The stand-down is COOPERATIVE, not exclusion: an export call can
      // start while we are parked mid-`await`, and we only notice at the next
      // `done()` evaluation, so a bounded overlap window remains by
      // construction (concurrent export calls have always overlapped too).
      // That is safe for the resume-once invariant — `resumeWith` deletes
      // from `store.awaiting` synchronously and every resumption site
      // re-checks membership *and* promise identity first; see the invariant
      // write-up on `storeDriverDepth` in boundary.ts. Standing down is about
      // not interleaving two loops' `serviceSettled`/`tick` phases, which is
      // what tripped `Trap: table entry empty` out of `runCallbackLoop` when
      // this pump first drove unconditionally alongside an export call.
      while (!quiescent(store)) {
        if (storeDriverDepth(store) > 0) {
          await whenStoreDriverIdle(store);
          continue;
        }
        await driveStoreAsync(
          store,
          // Quiescence, not completion: this pump exists to keep the guest
          // moving; the host operation's own promise is what the caller
          // awaits. Three exit clauses:
          //
          //   * nothing left that a turn of the event loop could advance
          //     (`quiescent`);
          //   * `pendingHostCalls` empty, which is the precondition of BOTH
          //     of `driveAsync`'s deadlock traps. Returning true there keeps
          //     this between-calls pump from converting the documented
          //     embedder-never-acts hang (module header) into a trap that
          //     would surface, misattributed, on some later export call.
          //     Deadlock detection for genuine component deadlock stays where
          //     it belongs: in the driving loop of the export call the guest
          //     is blocked in;
          //   * another driver appeared (an export call started while we were
          //     parked) — hand the store back to it, per the single-driver
          //     rule. Our depth is 1 while we are inside, hence `> 1`.
          () =>
            store.pendingHostCalls.size === 0 ||
            quiescent(store) ||
            storeDriverDepth(store) > 1,
          "host stream/future activity",
        );
      }
    } catch (e) {
      // Nothing is awaiting this pump, so park the failure where the next
      // driving loop will surface it (same channel as a host-import
      // rejection).
      store.hostFailure ??= e;
    } finally {
      this.#pumping = false;
    }
    // The pump advanced the guest OUTSIDE any export call's driving loop. A
    // `driveAsync` parked on `Promise.race([...pendingHostCalls])` re-evaluates
    // its `done` predicate only when something it raced settles — and
    // everything the pump just did (resume the callback task, deliver the
    // event, watch the guest `task.return`) may have settled nothing that race
    // can see. Re-arm through `notify()` so a parked driver wakes and
    // re-checks; without this the lifted call's Promise never resolves even
    // though the task resolved (observed: future-user's `double-future` under
    // jspi auto-detection — the guest finished, the embedder's await hung
    // forever).
    this.notify();
  }

  /** No further host activity is possible on this stream. */
  close(): void {
    const p = this.#promise, r = this.#resolve;
    this.#closed = true;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) {
      this.#store.pendingHostCalls.delete(p);
    }
    r?.();
  }
}

/** Host end the embedder WRITES; the guest reads. */
export interface HostWritableEnd<T> {
  /**
   * Offer `values`. Resolves with how many the guest actually took — a
   * partial copy is normal, not an error (definitions.py copies
   * `min(remain, remain)`). Re-offer the remainder to finish.
   *
   * `values` is BORROWED until the returned promise settles (the buffer may
   * stay parked across several partial reads); mutating it in that window is
   * misuse. Readers always receive their own copy.
   */
  write(values: T[]): Promise<number>;
  /**
   * Offer `values` repeatedly until all of them have been taken or the reader
   * goes away. Convenience over `write`, and the shape most embedders want.
   *
   * The loop is unavoidable in the single-shot form because of *which side
   * arrives second*: when the host arrives second the reference completes the
   * arriving call with just the count copied in that rendezvous
   * (`SharedStreamImpl.write` -> `on_copy_done(COMPLETED)`), leaving the rest
   * of the offer unsent. When the host arrives *first* it stays parked and is
   * drained across several guest reads. `writeAll` papers over the difference.
   *
   * Resolves with the total accepted, which is less than `values.length` only
   * if the reader dropped.
   */
  writeAll(values: T[]): Promise<number>;
  /**
   * Cancel an in-flight `write`/`writeAll` (definitions.py
   * `SharedStreamImpl.cancel` -> `CopyResult.CANCELLED`). No-op when nothing
   * of ours is parked. Surfaced per the R-fix review's stream advisory 1: the
   * cancel channel existed on the shared object but had no embedder-facing
   * spelling, so a host writer could only be abandoned, never retracted.
   */
  cancelWrite(): void;
  /** definitions.py `SharedStreamImpl.drop`: notifies a parked reader. */
  drop(): void;
}

/** Host end the embedder READS; the guest writes. */
export interface HostReadableEnd<T> {
  /**
   * Resolves with up to `max` values once the guest writes (or an empty
   * chunk on drop). A u8 stream resolves with a `Uint8Array` (see
   * `HostBuffer.taken`); every other element type resolves with a plain
   * array.
   */
  read(max: number): Promise<T[]>;
  /** Cancel an in-flight `read`; see `HostWritableEnd.cancelWrite`. */
  cancelRead(): void;
  drop(): void;
}

export interface HostStream<T> {
  readable: HostReadableEnd<T>;
  writable: HostWritableEnd<T>;
  /**
   * The value to pass across the boundary. Lowering it into a guest gives the
   * guest the **readable** end (`lower_stream`), so an embedder feeding a
   * guest uses `writable`; an embedder consuming a guest-produced stream gets
   * its shared object from the lift and wraps it with `hostStreamFor`.
   */
  value: ComponentValue;
}

/** Attach host-activity bookkeeping to a shared object as it is lowered. */
function bindOnLower(
  shared: SharedStreamImpl | SharedFutureImpl,
  activity: HostActivity,
  alsoOnLowered?: () => void,
): void {
  const holder = shared as unknown as {
    onLowered?: ((i: ComponentInstanceState) => void) | null;
  };
  // INTERNAL INVARIANT (not the embedder-facing policy): two live wrappers
  // on one shared object would mean two HostActivities pumping it, and the
  // second `onLowered` hook would silently orphan the first wrapper's
  // activity binding for future lowers (review advisory, host-streams
  // round). The public entry points cannot get here with a wrapped object —
  // `hostStreamFor`/`hostFutureFor` return the cached wrapper instead
  // (amendment A5) — so a trip here is a bug in this module. The class field
  // initializes to null; == null covers both sentinels.
  assert_(
    holder.onLowered == null,
    "internal: a second host wrapper was built for an already-wrapped " +
      "stream/future (the wrapper cache should have returned the first)",
  );
  holder.onLowered = (inst) => {
    alsoOnLowered?.();
    activity.bind(inst.store);
  };
  // A stream that came *out* of a guest was lifted, never lowered, so the hook
  // above will not fire; `boundStore` was recorded at lift time instead.
  const bound = (shared as { boundStore?: unknown }).boundStore;
  if (bound) activity.bind(bound as Store);
}

function mkStreamEnds<T>(
  shared: SharedStreamImpl,
  activity: HostActivity,
): { readable: HostReadableEnd<T>; writable: HostWritableEnd<T> } {
  // Distinct rendezvous identities per end — see `hostEndInstance`.
  const writeInst = hostEndInstance("write");
  const readInst = hostEndInstance("read");
  // Which of OUR operations is currently the shared object's pending side.
  // `SharedBase.cancel` retires whatever is parked, so cancelling is only
  // legal (and only meaningful) while the parked side is ours.
  const parked = { read: false, write: false };
  /**
   * Settle bookkeeping for a completed copy. `DROPPED` means the peer end is
   * gone: no further host activity on this end is possible, so the activity
   * arm is *closed* rather than re-armed (R-fix review advisory 2 — a live arm
   * after end-of-stream keeps `pendingHostCalls` non-empty forever and masks
   * a genuine deadlock as "the embedder might still act").
   */
  const settle = (result: CopyResult): void => {
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  return {
    writable: {
      write(values: T[]): Promise<number> {
        // One in-flight operation per end — the host-side spelling of the
        // `CopyEnd` busy trap guests get from the table. Without it a second
        // write would find the FIRST write's buffer in the shared object's
        // pending slot and "rendezvous" write-against-write, silently
        // copying into the parked buffer's accumulation (observed as a
        // write resolving `1` against a peer that no longer exists — the
        // #66 repro). Reading while a write is parked stays legal: that is
        // the pass-through data plane (two different ends).
        if (parked.write) {
          throw new TypeError(
            "a write is already in flight on this stream's writable end; " +
              "await it or cancelWrite() first",
          );
        }
        const buf = new HostBuffer(
          shared.t,
          values as unknown as ComponentValue[],
          values.length,
        );
        return new Promise<number>((resolve) => {
          parked.write = true;
          shared.write(
            writeInst,
            buf as never,
            // `on_copy`: a partial rendezvous happened. A guest end would be
            // handed a COMPLETED event here and decide for itself whether to
            // re-offer; a host end has no event loop, so we make the useful
            // choice and **stay parked** until the offer is exhausted. That is
            // exactly the shape wit-bindgen's `wit_stream::new()` produces —
            // a background write that the reader drains a few elements at a
            // time — and it is why `reclaim` is deliberately not called while
            // values remain: reclaiming retires the pending buffer and the
            // next guest read would find nothing.
            (reclaim) => {
              if (buf.remain() > 0) return; // still parked; more to give
              reclaim();
              parked.write = false;
              activity.notify();
              resolve(buf.progress);
            },
            (result: CopyResult) => {
              parked.write = false;
              settle(result);
              resolve(buf.progress);
            },
          );
          activity.notify();
          activity.pump();
        });
      },
      async writeAll(values: T[]): Promise<number> {
        let sent = 0;
        while (sent < values.length && !shared.dropped) {
          // Re-offers keep `write`'s borrow semantics: the first round is the
          // chunk itself and later rounds a `subarray` VIEW for typed chunks
          // (review F1: a `slice` here cost a second full copy on the very
          // path the one-copy contract names), a `slice` for plain arrays.
          const rest = sent === 0
            ? values
            : values instanceof Uint8Array
            ? values.subarray(sent) as unknown as T[]
            : values.slice(sent);
          const n = await this.write(rest);
          if (n === 0) break; // reader gone; nothing more will be taken
          sent += n;
        }
        return sent;
      },
      cancelWrite() {
        if (!parked.write) return;
        parked.write = false;
        shared.cancel();
        activity.notify();
        activity.pump();
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      },
    },
    readable: {
      read(max: number): Promise<T[]> {
        // One in-flight operation per end — see the write() guard: a second
        // read would rendezvous read-against-read with our own parked
        // buffer.
        if (parked.read) {
          throw new TypeError(
            "a read is already in flight on this stream's readable end; " +
              "await it or cancelRead() first",
          );
        }
        const buf = new HostBuffer(shared.t, null, max);
        return new Promise<T[]>((resolve) => {
          parked.read = true;
          shared.read(
            readInst,
            buf as never,
            (reclaim) => {
              reclaim();
              parked.read = false;
              activity.notify();
              resolve(buf.taken() as unknown as T[]);
            },
            (result: CopyResult) => {
              parked.read = false;
              settle(result);
              resolve(buf.taken() as unknown as T[]);
            },
          );
          activity.notify();
          activity.pump();
        });
      },
      cancelRead() {
        // #97, DELIBERATE AND PINNED: cancelling resolves the in-flight
        // `read` promise with whatever the buffer took so far — for a read
        // that had not yet rendezvoused, the empty chunk. An empty chunk is
        // also this layer's end-of-stream signal (see `HostReadableEnd.read`
        // and embedder/streams.ts `Stream.read`), so **a host-cancelled read
        // is indistinguishable from EOS at the conventions layer**. That is
        // accepted rather than papered over: the code that calls
        // `cancelRead()` is the same code that observes the result, so it
        // already knows which of the two happened. Nothing else can reach
        // this state — a guest cannot cancel the host's read.
        if (!parked.read) return;
        parked.read = false;
        shared.cancel();
        activity.notify();
        activity.pump();
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      },
    },
  };
}

/**
 * One host wrapper per shared object, by identity (embedder-api amendment
 * A5). A stream/future value that round-trips host → guest → host lifts back
 * as the SAME wrapper the host already holds, so wrapping is idempotent —
 * there is never a second `HostActivity` competing to pump one shared object
 * (the hazard the old double-wrap assert guarded against), and the readable
 * end stays transferable across as many boundary hops as the spec allows.
 */
const streamWrappers = new WeakMap<object, HostStream<unknown>>();
const futureWrappers = new WeakMap<object, HostFuture<unknown>>();

/** Create a host-owned stream of `element` (`null` = zero-width payload). */
export function hostStream<T>(element: ValType | null): HostStream<T> {
  const shared = new SharedStreamImpl(element);
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  const ends = mkStreamEnds<T>(shared, activity);
  const wrapper = { ...ends, value: shared as unknown as ComponentValue };
  streamWrappers.set(shared, wrapper as HostStream<unknown>);
  return wrapper;
}

/**
 * Wrap a stream that came *out* of a guest (from `liftStream`). Idempotent:
 * a shared object that already has a host wrapper (it was created by
 * `hostStream`, or lifted before) yields that same wrapper.
 */
export function hostStreamFor<T>(value: ComponentValue): HostStream<T> {
  const shared = value as unknown as SharedStreamImpl;
  assert_(
    shared instanceof SharedStreamImpl,
    "hostStreamFor expects a lifted stream value",
  );
  const cached = streamWrappers.get(shared);
  if (cached !== undefined) return cached as HostStream<T>;
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  const ends = mkStreamEnds<T>(shared, activity);
  const wrapper = { ...ends, value };
  streamWrappers.set(shared, wrapper as HostStream<unknown>);
  return wrapper;
}

export interface HostFuture<T> {
  /** Deliver the future's single value. */
  write(value: T): Promise<void>;
  /** Await the future's single value. */
  read(): Promise<T | undefined>;
  /**
   * `read`, but reporting *why* it settled. A future carries at most one
   * value, so `read`'s `undefined` is ambiguous between "the value was
   * `undefined`" (a `future<void>`) and "the write end dropped without ever
   * writing" — the case the conventions layer must turn into a
   * `DroppedError` (R-fix review advisory 4). `result` disambiguates:
   * `COMPLETED` iff `value` is real.
   */
  readResult(): Promise<{ value: T | undefined; result: CopyResult }>;
  /** Cancel an in-flight `read`/`write`; see `HostWritableEnd.cancelWrite`. */
  cancel(): void;
  /**
   * Release this future. Total and idempotent (#90): it never throws, and a
   * second call is a no-op.
   *
   * Three cases, per the #90 ruling:
   *
   *  * the value was already delivered (the normal write-then-drop path) —
   *    plain state cleanup, the spec's `WritableFutureEnd.drop` precondition
   *    (definitions.py:1183-1184) is satisfied;
   *  * never written, and the future was **lowered** into a guest (the guest
   *    holds the readable end, so this wrapper plays the spec's writable
   *    role) — *abandon*: the reader can never be satisfied, so it is armed
   *    with the rendezvous-point trap (task/streams.ts `abandonSharedFuture`)
   *    rather than being handed a DROPPED it may not observe;
   *  * never written and never lowered — no guest ever saw it; plain
   *    cleanup.
   */
  drop(): void;
  value: ComponentValue;
}

/** Create a host-owned future of `element`. */
export function hostFuture<T>(element: ValType | null): HostFuture<T> {
  const shared = new SharedFutureImpl(element);
  const activity = new HostActivity();
  const lowering = { lowered: false };
  bindOnLower(shared, activity, () => lowering.lowered = true);
  const wrapper = mkFuture<T>(
    shared,
    activity,
    shared as unknown as ComponentValue,
    lowering,
  );
  futureWrappers.set(shared, wrapper as HostFuture<unknown>);
  return wrapper;
}

/**
 * Wrap a future that came *out* of a guest (from `liftFuture`). Idempotent —
 * see `hostStreamFor`.
 */
export function hostFutureFor<T>(value: ComponentValue): HostFuture<T> {
  const shared = value as unknown as SharedFutureImpl;
  assert_(
    shared instanceof SharedFutureImpl,
    "hostFutureFor expects a lifted future value",
  );
  const cached = futureWrappers.get(shared);
  if (cached !== undefined) return cached as HostFuture<T>;
  const activity = new HostActivity();
  const lowering = { lowered: false };
  bindOnLower(shared, activity, () => lowering.lowered = true);
  const wrapper = mkFuture<T>(shared, activity, value, lowering);
  futureWrappers.set(shared, wrapper as HostFuture<unknown>);
  return wrapper;
}

function mkFuture<T>(
  shared: SharedFutureImpl,
  activity: HostActivity,
  value: ComponentValue,
  /**
   * Flipped by `bindOnLower` the first time this future is lowered into a
   * guest — i.e. the first time a guest receives its READABLE end and this
   * wrapper takes on the spec's writable role. `drop()` needs it (#90).
   */
  lowering: { lowered: boolean },
): HostFuture<T> {
  // Distinct rendezvous identities per end — see `hostEndInstance`.
  const writeInst = hostEndInstance("write");
  const readInst = hostEndInstance("read");
  const parked = { any: false };
  /** Set once the future's one value has actually crossed (#90). */
  let delivered = false;
  const settle = (result: CopyResult): void => {
    parked.any = false;
    if (result === CopyResult.COMPLETED) delivered = true;
    if (result === CopyResult.DROPPED) activity.close();
    else activity.notify();
  };
  const self: HostFuture<T> = {
    write(v: T): Promise<void> {
      // One in-flight operation per wrapper — see mkStreamEnds' guards: a
      // second op would rendezvous against our own parked buffer.
      if (parked.any) {
        throw new TypeError(
          "an operation is already in flight on this future; " +
            "await it or cancel() first",
        );
      }
      // definitions.py `SharedFutureImpl.write` asserts `remain() == 1`: a
      // future carries exactly one element.
      const buf = new HostBuffer(shared.t, [v as unknown as ComponentValue], 1);
      return new Promise<void>((resolve) => {
        parked.any = true;
        shared.write(writeInst, buf as never, (result: CopyResult) => {
          settle(result);
          resolve();
        });
        activity.notify();
        activity.pump();
      });
    },
    readResult(): Promise<{ value: T | undefined; result: CopyResult }> {
      // One in-flight operation per wrapper — see write().
      if (parked.any) {
        throw new TypeError(
          "an operation is already in flight on this future; " +
            "await it or cancel() first",
        );
      }
      // definitions.py `SharedFutureImpl.read` asserts `not self.dropped`, so
      // a read after the write end went away must be answered here rather
      // than by tripping an internal assertion.
      if (shared.dropped) {
        return Promise.resolve({
          value: undefined,
          result: CopyResult.DROPPED,
        });
      }
      const buf = new HostBuffer(shared.t, null, 1);
      return new Promise((resolve) => {
        parked.any = true;
        shared.read(readInst, buf as never, (result: CopyResult) => {
          settle(result);
          resolve({
            value: buf.taken()[0] as unknown as T | undefined,
            result,
          });
        });
        activity.notify();
        activity.pump();
      });
    },
    async read(): Promise<T | undefined> {
      return (await self.readResult()).value;
    },
    cancel(): void {
      if (!parked.any) return;
      parked.any = false;
      shared.cancel();
      activity.notify();
      activity.pump();
    },
    drop() {
      // #90. Never throws, idempotent: `SharedFutureImpl.drop` and
      // `abandonSharedFuture` both no-op on an already-dropped future, and
      // neither can raise. See the `HostFuture.drop` doc for the three cases.
      if (!delivered && lowering.lowered && !shared.dropped) {
        abandonSharedFuture(
          shared,
          new Error(
            "the host dropped the writable end of this future without " +
              "writing a value",
          ),
        );
      } else {
        shared.drop();
      }
      activity.close();
      activity.pump();
    },
    value,
  };
  return self;
}

/** Re-exported so embedders can build element types without importing cabi. */
export { sameElemType };
