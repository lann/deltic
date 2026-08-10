// `wasi:io@0.2` — error, poll, streams (contracts/embedder-api.md
// §"WASI examination").
//
// THE PARKING KERNEL. `pollable.block()`, `poll()` and `blocking-*` are
// sync WIT functions that must genuinely wait — the one p2 idiom that
// fights a JS host. This package used to ship always-ready stubs (the
// retired "three-tier strategy", grounded in C0 finding #6: no consumer
// leg ever called a pollable method) with real parking documented as
// "never (c) in this package". Both halves of that ruling expired:
//
//   * the polymorph-iroh upstream-iroh consumer class (unmodified
//     iroh/tokio) parks its reactor in `poll()` with timer + socket
//     pollables — the always-ready stubs don't degrade for such a guest,
//     they LIVELOCK it (block() no-ops, reads return empty, the frame
//     never suspends, so the event loop never turns and no host pump can
//     ever make progress);
//   * the runtime's suspending-import machinery (embedder-api.md A1/A2)
//     made real parking a per-declaration capability with graceful
//     degradation, so the kernel is ALWAYS ON rather than an opt-in
//     profile: on engines without JSPI, `chooseMode` falls back to plain
//     and everything behaves like the old stubs until a guest genuinely
//     parks — which then raises a clean `NeedsJspi` at the park site
//     instead of livelocking. Embedders wanting guaranteed-plain
//     instantiation pass `jspi: false`.
//
// Costs, deliberately confined: only the park-capable declarations are
// marked (`block`, `poll`) — hot-path `read`/`check-write` stay plain —
// and marking flips wasi-consuming components into jspi mode on JSPI
// engines (see the contract note on the narrowed zero-cost pin).
//
// INTEROP SEAM: `Pollable` is publicly constructible —
// `new Pollable(ready, wait)` — because external providers mint pollables
// this kernel must `poll()` uniformly. The known consumer's sockets glue
// (deliberately outside this package, per the delivery ruling) wires
// pollables to datagram queues exactly this way; the reference for the
// wake pattern is polymorph-iroh's shim (promise-swap edge triggering).
//
// Streams stay buffer-backed: `read`/`check-write` serve synchronously
// from host-side buffers, so their fast path never parks — sufficient
// for every known consumer (the iroh class does no stream I/O; its bytes
// ride datagrams).

import { suspending, WitError } from "@deltic/runtime/embedder";

/** A p2 `stream-error` value (variant): `closed` or `last-operation-failed`. */
export type StreamErrorValue =
  | { tag: "closed" }
  | { tag: "last-operation-failed"; val: IoError };

function closedError(): WitError<StreamErrorValue> {
  return new WitError({ tag: "closed" });
}

/**
 * `wasi:io/error.error` — the generic downcastable error resource
 * (io.wit:23). This shim never produces one organically (streams fail with
 * `closed` only, never `last-operation-failed`); the class exists so the
 * resource *type* is a legal import target and so a future producer of one
 * has somewhere to construct it.
 */
export class IoError {
  #message: string;
  constructor(message = "I/O error") {
    this.#message = message;
  }
  toDebugString(): string {
    return this.#message;
  }
}

/**
 * A pollable over host-supplied readiness.
 *
 * WIT-facing surface: `ready()` and `block()` (the latter parks the
 * calling wasm frame when unready — @suspending, embedder-api.md A2:
 * the class prototype is the brand authority).
 *
 * Host-facing surface: the constructor and `waitPromise()`. `ready` must
 * be cheap and side-effect-free; `wait` returns a promise that settles
 * when readiness MAY have changed — block/poll re-check and re-wait in a
 * loop, so spurious wakes are fine and `wait` is called repeatedly (return
 * the CURRENT epoch's promise each call; the promise-swap pattern — settle
 * and re-arm on every event — is the intended producer shape). The default
 * (no arguments) is an always-ready pollable, the honest shape for
 * type-only linkage and never-backpressured sinks.
 */
export class Pollable {
  #ready: () => boolean;
  #wait: () => Promise<void>;

  constructor(
    ready: () => boolean = () => true,
    wait: () => Promise<void> = () => Promise.resolve(),
  ) {
    this.#ready = ready;
    this.#wait = wait;
  }

  /**
   * A pollable that becomes ready at `deadline` (nanoseconds on the
   * caller's clock). The timer is armed lazily on first wait and shared
   * across waiters; `ready()` consults the clock, so it is exact even if
   * the setTimeout fires early/late by a tick.
   */
  static timer(deadlineNs: bigint, nowNs: () => bigint): Pollable {
    let armed: Promise<void> | undefined;
    const wait = (): Promise<void> => {
      return armed ??= new Promise((resolve) => {
        const deltaMs = Number(deadlineNs - nowNs()) / 1e6;
        setTimeout(resolve, Math.max(0, deltaMs));
      });
    };
    return new Pollable(() => nowNs() >= deadlineNs, wait);
  }

  ready(): boolean {
    return this.#ready();
  }

  /** Parks the calling wasm frame until ready (sync fast path when
   * already ready — no suspension, per-declaration marking only adds the
   * engine's continuation hop). */
  @suspending
  block(): void | Promise<void> {
    if (this.#ready()) return;
    return (async () => {
      while (!this.#ready()) await this.#wait();
    })();
  }

  /** Host-facing (not part of the WIT resource surface): the current
   * epoch's wake promise, raced by `poll`. */
  waitPromise(): Promise<void> {
    return this.#wait();
  }
}

/**
 * `wasi:io/poll.poll` — indices of the ready pollables, parking the
 * calling frame until at least one is ready. Sync fast path: if anything
 * is ready right now, the indices return without a suspension.
 */
export const poll = suspending(
  (pollables: readonly Pollable[]): number[] | Promise<number[]> => {
    // io.wit: "poll [...] traps if the list [...] is empty". An unbranded
    // host throw is the embedder contract's spelling of a trap.
    if (pollables.length === 0) {
      throw new Error("wasi:io/poll.poll: empty pollable list");
    }
    const readyNow = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < pollables.length; i++) {
        if (pollables[i].ready()) out.push(i);
      }
      return out;
    };
    const first = readyNow();
    if (first.length > 0) return first;
    return (async () => {
      for (;;) {
        await Promise.race(pollables.map((p) => p.waitPromise()));
        const ready = readyNow();
        if (ready.length > 0) return ready;
      }
    })();
  },
);

/**
 * Buffer-backed input stream: serves `read`/`blocking-read` synchronously
 * from an in-memory buffer supplied at construction (default empty,
 * matching stdin's default in this package). Blocking degenerates to the
 * sync read because the buffer is always immediately available.
 */
export class InputStream {
  #buf: Uint8Array;
  #pos = 0;
  #closed = false;

  constructor(buf: Uint8Array = new Uint8Array(0)) {
    this.#buf = buf;
  }

  read(len: bigint): Uint8Array {
    if (this.#closed) throw closedError();
    const n = Math.max(0, Math.min(Number(len), this.#buf.length - this.#pos));
    const out = this.#buf.slice(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }

  blockingRead(len: bigint): Uint8Array {
    return this.read(len);
  }

  skip(len: bigint): bigint {
    return BigInt(this.read(len).length);
  }

  blockingSkip(len: bigint): bigint {
    return this.skip(len);
  }

  subscribe(): Pollable {
    return new Pollable();
  }

  [Symbol.dispose](): void {
    this.#closed = true;
  }
}

/**
 * Buffer-backed output stream over a byte sink. `checkWrite` always
 * reports a large permit (the sink never truly backs up), so the
 * synchronous fast path is always taken and `blocking-*` methods
 * degenerate to their non-blocking counterparts.
 */
export class OutputStream {
  #sink: (chunk: Uint8Array) => void;
  #closed = false;

  constructor(sink: (chunk: Uint8Array) => void) {
    this.#sink = sink;
  }

  checkWrite(): bigint {
    if (this.#closed) throw closedError();
    return 65536n;
  }

  write(contents: Uint8Array): void {
    if (this.#closed) throw closedError();
    this.#sink(contents);
  }

  blockingWriteAndFlush(contents: Uint8Array): void {
    this.write(contents);
  }

  flush(): void {
    if (this.#closed) throw closedError();
  }

  blockingFlush(): void {
    this.flush();
  }

  subscribe(): Pollable {
    return new Pollable();
  }

  writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  blockingWriteZeroesAndFlush(len: bigint): void {
    this.writeZeroes(len);
  }

  splice(src: InputStream, len: bigint): bigint {
    const chunk = src.read(len);
    this.write(chunk);
    return BigInt(chunk.length);
  }

  blockingSplice(src: InputStream, len: bigint): bigint {
    return this.splice(src, len);
  }

  [Symbol.dispose](): void {
    this.#closed = true;
  }
}

/** `wasi:io@0.2` provider fragment (track key). */
export function io(): { imports: Record<string, unknown> } {
  return {
    imports: {
      "wasi:io/error@0.2": { Error: IoError },
      "wasi:io/poll@0.2": { Pollable, poll },
      "wasi:io/streams@0.2": { InputStream, OutputStream },
    },
  };
}
