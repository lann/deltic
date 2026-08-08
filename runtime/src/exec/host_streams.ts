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

import { assert_ } from "../cabi/trap.ts";
import type { ComponentValue, ValType } from "../cabi/types.ts";
import {
  clearResumingThread,
  type ComponentInstanceState,
  CopyResult,
  setResumingThread,
  sameElemType,
  SharedFutureImpl,
  SharedStreamImpl,
  type Store,
} from "../task/mod.ts";

/**
 * The `inst` a host end presents to the rendezvous. definitions.py compares it
 * against `pending_inst` for the "same instance" restriction; a unique
 * sentinel can never collide with a real `ComponentInstanceState`, which is
 * the correct answer — the host is not a component instance.
 */
export const HOST_INSTANCE: unknown = Object.freeze({ hostEnd: true });

/**
 * A buffer over a JS array. Sibling of `GuestBuffer`, same four methods, no
 * memory access. Used in one of two directions:
 *
 *   * as a *readable* buffer (host supplies `values`, the guest reads them);
 *   * as a *writable* buffer (host supplies capacity, the guest fills it and
 *     `taken` is what arrived).
 */
export class HostBuffer {
  progress = 0;
  readonly taken: ComponentValue[] = [];

  constructor(
    readonly t: ValType | null,
    private readonly values: ComponentValue[] | null,
    readonly length: number,
  ) {}

  remain(): number {
    return this.length - this.progress;
  }

  isZeroLength(): boolean {
    return this.length === 0;
  }

  /** Guest side is reading from us. */
  read(n: number): ComponentValue[] {
    assert_(n <= this.remain(), "host buffer read beyond remaining");
    const out = this.values === null
      ? new Array(n).fill(null)
      : this.values.slice(this.progress, this.progress + n);
    this.progress += n;
    return out;
  }

  /** Guest side is writing into us. */
  write(vs: ComponentValue[]): void {
    assert_(vs.length <= this.remain(), "host buffer write beyond remaining");
    for (const v of vs) this.taken.push(v);
    this.progress += vs.length;
  }
}

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

  bind(store: Store): void {
    if (this.#store !== null || this.#closed) return;
    this.#store = store;
    this.#arm();
  }

  #arm(): void {
    if (this.#store === null || this.#promise !== null || this.#closed) return;
    this.#promise = new Promise<void>((r) => (this.#resolve = r));
    this.#store.pendingHostCalls.add(this.#promise);
  }

  /** The embedder did something; let the driving loop re-pump. */
  notify(): void {
    const p = this.#promise, r = this.#resolve;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) this.#store.pendingHostCalls.delete(p);
    r?.();
    this.#arm();
  }

  /**
   * Drive the guest until it can make no more progress.
   *
   * A host operation that lands *between* export calls has no driving loop
   * running — `drive()` returned when the last export call resolved. So after
   * initiating a host read/write (or a drop) we pump the store ourselves,
   * which is the same `while (store.tick())` the host boundary runs. Without
   * this a guest parked in a background forwarding task would never be
   * resumed to consume what we just offered, and the host read would await
   * forever. Traps propagate to the caller of the host operation, which is the
   * only place that can report them.
   */
  pump(): void {
    const store = this.#store;
    if (store === null) return;
    while (store.tick());
    // In jspi mode a guest can be parked on a Promise rather than on a
    // scheduler condition, and `tick` cannot move those — only awaiting them
    // can. Kick off an asynchronous drain; the host operation the caller is
    // awaiting resolves when the rendezvous completes, so this only has to
    // keep the guest running, not report anything.
    if (store.awaiting.size > 0) void this.#drainAsync(store);
  }

  async #drainAsync(store: Store): Promise<void> {
    try {
      while (store.awaiting.size > 0) {
        const t = [...store.awaiting][0] as {
          awaiting: Promise<unknown> | null;
          resumeWith(v: unknown, f?: { error: unknown }): void;
        };
        store.awaiting.delete(t);
        const p = t.awaiting!;
        setResumingThread(t);
        let value: unknown;
        let failure: { error: unknown } | undefined;
        try {
          value = await p;
        } catch (e) {
          failure = { error: e };
        }
        clearResumingThread();
        t.resumeWith(value, failure);
        while (store.tick());
      }
    } catch (e) {
      // Nothing is awaiting this drain, so park the failure where the next
      // driving loop will surface it (same channel as a host-import rejection).
      store.hostFailure ??= e;
    }
  }

  /** No further host activity is possible on this stream. */
  close(): void {
    const p = this.#promise, r = this.#resolve;
    this.#closed = true;
    this.#promise = null;
    this.#resolve = null;
    if (p !== null && this.#store !== null) this.#store.pendingHostCalls.delete(p);
    r?.();
  }
}

/** Host end the embedder WRITES; the guest reads. */
export interface HostWritableEnd<T> {
  /**
   * Offer `values`. Resolves with how many the guest actually took — a
   * partial copy is normal, not an error (definitions.py copies
   * `min(remain, remain)`). Re-offer the remainder to finish.
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
  /** definitions.py `SharedStreamImpl.drop`: notifies a parked reader. */
  drop(): void;
}

/** Host end the embedder READS; the guest writes. */
export interface HostReadableEnd<T> {
  /** Resolves with up to `max` values once the guest writes (or `[]` on drop). */
  read(max: number): Promise<T[]>;
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
): void {
  const holder = shared as unknown as {
    onLowered?: ((i: ComponentInstanceState) => void) | null;
  };
  // Double-wrapping one shared object would silently orphan the first
  // wrapper's activity binding for future lowers — refuse loudly instead
  // (review advisory, host-streams round). The class field initializes to
  // null; == null covers both sentinels.
  assert_(
    holder.onLowered == null,
    "this stream/future is already wrapped by a host end; " +
      "hostStreamFor/hostFutureFor may wrap a shared object once",
  );
  holder.onLowered = (inst) => activity.bind(inst.store);
  // A stream that came *out* of a guest was lifted, never lowered, so the hook
  // above will not fire; `boundStore` was recorded at lift time instead.
  const bound = (shared as { boundStore?: unknown }).boundStore;
  if (bound) activity.bind(bound as Store);
}

function mkStreamEnds<T>(
  shared: SharedStreamImpl,
  activity: HostActivity,
): { readable: HostReadableEnd<T>; writable: HostWritableEnd<T> } {
  return {
    writable: {
      write(values: T[]): Promise<number> {
        const buf = new HostBuffer(
          shared.t,
          values as unknown as ComponentValue[],
          values.length,
        );
        return new Promise<number>((resolve) => {
          shared.write(
            HOST_INSTANCE,
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
              activity.notify();
              resolve(buf.progress);
            },
            (_result: CopyResult) => {
              activity.notify();
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
          const n = await this.write(values.slice(sent));
          if (n === 0) break; // reader gone; nothing more will be taken
          sent += n;
        }
        return sent;
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      },
    },
    readable: {
      read(max: number): Promise<T[]> {
        const buf = new HostBuffer(shared.t, null, max);
        return new Promise<T[]>((resolve) => {
          shared.read(
            HOST_INSTANCE,
            buf as never,
            (reclaim) => {
              reclaim();
              activity.notify();
              resolve(buf.taken as unknown as T[]);
            },
            (_result: CopyResult) => {
              activity.notify();
              resolve(buf.taken as unknown as T[]);
            },
          );
          activity.notify();
          activity.pump();
        });
      },
      drop() {
        shared.drop();
        activity.close();
        activity.pump();
      },
    },
  };
}

/** Create a host-owned stream of `element` (`null` = zero-width payload). */
export function hostStream<T>(element: ValType | null): HostStream<T> {
  const shared = new SharedStreamImpl(element);
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  const ends = mkStreamEnds<T>(shared, activity);
  return { ...ends, value: shared as unknown as ComponentValue };
}

/** Wrap a stream that came *out* of a guest (from `liftStream`). */
export function hostStreamFor<T>(value: ComponentValue): HostStream<T> {
  const shared = value as unknown as SharedStreamImpl;
  assert_(
    shared instanceof SharedStreamImpl,
    "hostStreamFor expects a lifted stream value",
  );
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  const ends = mkStreamEnds<T>(shared, activity);
  return { ...ends, value };
}

export interface HostFuture<T> {
  /** Deliver the future's single value. */
  write(value: T): Promise<void>;
  /** Await the future's single value. */
  read(): Promise<T | undefined>;
  drop(): void;
  value: ComponentValue;
}

/** Create a host-owned future of `element`. */
export function hostFuture<T>(element: ValType | null): HostFuture<T> {
  const shared = new SharedFutureImpl(element);
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  return mkFuture<T>(shared, activity, shared as unknown as ComponentValue);
}

/** Wrap a future that came *out* of a guest (from `liftFuture`). */
export function hostFutureFor<T>(value: ComponentValue): HostFuture<T> {
  const shared = value as unknown as SharedFutureImpl;
  assert_(
    shared instanceof SharedFutureImpl,
    "hostFutureFor expects a lifted future value",
  );
  const activity = new HostActivity();
  bindOnLower(shared, activity);
  return mkFuture<T>(shared, activity, value);
}

function mkFuture<T>(
  shared: SharedFutureImpl,
  activity: HostActivity,
  value: ComponentValue,
): HostFuture<T> {
  return {
    write(v: T): Promise<void> {
      // definitions.py `SharedFutureImpl.write` asserts `remain() == 1`: a
      // future carries exactly one element.
      const buf = new HostBuffer(shared.t, [v as unknown as ComponentValue], 1);
      return new Promise<void>((resolve) => {
        shared.write(HOST_INSTANCE, buf as never, () => {
          activity.notify();
          resolve();
        });
        activity.notify();
        activity.pump();
      });
    },
    read(): Promise<T | undefined> {
      const buf = new HostBuffer(shared.t, null, 1);
      return new Promise<T | undefined>((resolve) => {
        shared.read(HOST_INSTANCE, buf as never, () => {
          activity.notify();
          resolve(buf.taken[0] as unknown as T | undefined);
        });
        activity.notify();
        activity.pump();
      });
    },
    drop() {
      shared.drop();
      activity.close();
      activity.pump();
    },
    value,
  };
}

/** Re-exported so embedders can build element types without importing cabi. */
export { sameElemType };
