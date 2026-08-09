// `wasi:io@0.2` — error, poll, streams (contracts/embedder-api.md
// §"WASI examination", the p2 pollable + stream idioms).
//
// Tier strategy (contract, three-tier): (a) type-only `Pollable` stub — C0
// finding #6 (tools/smoke-c0/REPORT.md §6): the entire consumer corpus links
// `wasi:io/poll` via the libc wasip2 baseline, yet no leg ever called a
// pollable method, so a pollable that is always `ready()` needs no real
// parking; (b) buffer-backed streams — `OutputStream`/`InputStream` serve
// synchronously from host-side buffers, so their fast path never blocks.
// Tier (c) (JSPI suspension) is never implemented in this package.

import { WitError } from "@deltic/runtime/embedder";

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
 * Tier (a): a pollable that is always ready.
 *
 * CONTRACT (contracts/embedder-api.md §"WASI examination"): `block()` is the
 * one p2 idiom that "fights a JS host" — a synchronous WIT function that must
 * park. This class takes the tier-(a) default: `ready()` is unconditionally
 * `true` and `block()` is a documented no-op, never a real park. Justification
 * (C0 finding #6, tools/smoke-c0/REPORT.md §6): across the full consumer
 * corpus under test, every leg links `wasi:io/poll` as part of the libc p2
 * baseline, but **no leg ever calls a pollable method** — the guests always
 * take the eventually-consistent synchronous fast path instead. If a future
 * consumer's guest genuinely blocks on a pollable, tier (c) (JSPI-backed
 * suspension) is the documented escape hatch; it is deliberately not
 * implemented here (mission: "never (c) in this package").
 */
export class Pollable {
  ready(): boolean {
    return true;
  }
  /** Tier (a) no-op — see class doc. Never parks. */
  block(): void {}
}

/** `wasi:io/poll.poll` — tier (a): every pollable is ready, so every index is returned. */
export function poll(pollables: readonly Pollable[]): number[] {
  return pollables.map((_p, i) => i);
}

/**
 * Tier (b): a fixed/empty-buffer input stream.
 *
 * Serves `read`/`blocking-read` from an in-memory buffer supplied at
 * construction (default empty, matching stdin's default in this package).
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

  /** Tier (b): the buffer is always immediately available; blocking degenerates to `read`. */
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
 * Tier (b): an output stream over a byte sink.
 *
 * `checkWrite` always reports a large permit (the sink never truly backs
 * up), so the synchronous fast path is always taken and `blocking-*` methods
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
