// Stream / future conventions (contracts/embedder-api.md §"Streams and
// futures"; C2 checklist item 4).
//
// The low-level seam is `exec/host_streams.ts` — `HostStream`/`HostFuture`
// over the shared rendezvous object. This file is the *handle* layer named by
// the contract: `SharedStreamImpl` identity stays internal, embedders see
// `Stream<T>` / `Future<T>` / `ErrorContext`, and lowering accepts the natural
// JS producers (`ReadableStream`, `AsyncIterable`, arrays, `Promise`) with the
// layer owning the pumping.

import type { ValType } from "../cabi/types.ts";
import { despecialize } from "../cabi/types.ts";
import type { ComponentValue } from "../cabi/types.ts";
import {
  type HostFuture,
  hostFuture,
  hostFutureFor,
  type HostStream,
  hostStream,
  hostStreamFor,
} from "../exec/host_streams.ts";
import {
  CopyResult,
  dropSharedForTeardown,
  ErrorContext as InternalErrorContext,
  poisonFailureOf,
} from "../task/mod.ts";
import { DroppedError, PeerTrappedError } from "./errors.ts";

/** `Chunk<u8>` is a `Uint8Array`; every other element type chunks as `T[]`. */
export type Chunk<T> = T extends number ? Uint8Array | T[] : T[];

/** Per-element adaptation, supplied by the value adapter. */
export interface ElemCodec<T> {
  readonly element: ValType | null;
  /** internal component value -> conventions value */
  toHost(v: ComponentValue): T;
  /** conventions value -> internal component value */
  fromHost(v: T): ComponentValue;
  /** Optional site name (`import 'x'.f`, `export 'i#f'`) for diagnostics. */
  readonly where?: string;
}

/**
 * A producer feeding a lowered `stream<T>` failed — the element did not lower,
 * or the producer itself threw.
 *
 * This is a *host bug at a named site*, exactly like an unbranded throw from a
 * host import, and it is surfaced the same way: never as a silent truncation
 * of the guest's stream, never as a floating rejection.
 */
export class StreamProducerError extends Error {
  override readonly cause: unknown;

  constructor(where: string, cause: unknown) {
    super(
      `${where}: the stream producer failed — ` +
        `${describeCause(cause)}. The guest's stream is NOT closed cleanly: ` +
        `the in-flight call fails instead, because a short stream presented ` +
        `as end-of-stream would be wrong data reported as success.`,
    );
    this.name = "StreamProducerError";
    this.cause = cause;
  }
}

function describeCause(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Failures recorded against a shared stream object whose driving store could
 * not be reached (the stream was never lowered, or the store already carries a
 * failure). Surfaced on the next interaction with the handle.
 */
const producerFailures = new WeakMap<object, StreamProducerError>();

/**
 * Report a producer failure on the channel that can actually attribute it.
 *
 * PRIMARY channel: `store.hostFailure`. This is the runtime's existing
 * host-side failure slot — `driveAsync` checks it after every tick and throws
 * it out of the driving loop (exec/boundary.ts:468/647/679/692), which is the
 * driving loop of *the export call that is consuming this stream*. So the call
 * that would otherwise have resolved with truncated data rejects with this
 * error instead. It is the same channel `HostActivity.#pumpAsync` already uses
 * for a trap raised while pumping between export calls
 * (exec/host_streams.ts:284), so the two host-side stream failure paths agree.
 *
 * The report happens BEFORE the write end is dropped: the drop is what lets
 * the guest observe end-of-stream and resolve, and `driveAsync` checks
 * `hostFailure` before it checks `done()`.
 *
 * FALLBACK: no store bound (the stream was never lowered), or the store
 * already carries an earlier failure. Then the cause is recorded against the
 * shared object and raised on the next interaction with the handle.
 */
function reportProducerFailure(
  host: HostStream<unknown>,
  where: string,
  cause: unknown,
): boolean {
  const err = cause instanceof StreamProducerError
    ? cause
    : new StreamProducerError(where, cause);
  const shared = host.value as unknown as {
    boundStore?: { hostFailure?: unknown } | null;
  };
  producerFailures.set(host.value as object, err);
  const store = shared.boundStore;
  if (store != null && typeof store === "object") {
    if (store.hostFailure === undefined) store.hostFailure = err;
    return true;
  }
  return false;
}

/** @internal — raise a recorded producer failure, if any. */
function throwIfFailed(value: unknown, where = "stream"): void {
  const e = producerFailures.get(value as object);
  if (e !== undefined) throw e;
  throwIfPeerTrapped(value, where);
}

/**
 * @internal — raise the recorded poisoning failure, if any (#66, amendment
 * A7). Pre-op: an operation started after the peer's instance trapped must
 * reject rather than park forever. Post-await (with the op's outcome in
 * hand): an operation the retirement walk settled DROPPED-shaped must reject
 * rather than fake a clean end — but an op that genuinely COMPLETED before
 * the trap keeps its result (the fault still surfaces on the export call,
 * and on this handle's next operation).
 */
function throwIfPeerTrapped(
  value: unknown,
  where: string,
  progress?: number,
): void {
  const p = poisonFailureOf(value);
  if (p !== undefined) throw new PeerTrappedError(where, p, progress);
}

/** True for `stream<u8>` / `future<u8>`, whose chunks are `Uint8Array`. */
export function isU8Element(element: ValType | null): boolean {
  return element !== null && despecialize(element).kind === "u8";
}

/**
 * A stream handle.
 *
 * `read` returning an empty chunk is end-of-stream, exactly as the contract
 * spells it; `readable()` and the async iterator are built on it.
 */
export class Stream<T> {
  #host: HostStream<T> | null;
  #codec: ElemCodec<T> | null;
  /** Set once the handle's shared object has been handed to a guest. */
  #consumed = false;
  #dropped = false;
  /** Waiters parked in `Stream.create()` until an element type is known. */
  #binders: (() => void)[] = [];

  private constructor(host: HostStream<T> | null, codec: ElemCodec<T> | null) {
    this.#host = host;
    this.#codec = codec;
  }

  /** Wrap a stream value that was lifted out of a guest. */
  static fromLifted<T>(value: ComponentValue, codec: ElemCodec<T>): Stream<T> {
    return new Stream<T>(hostStreamFor<T>(value), codec);
  }

  /** Wrap a freshly created host-owned stream of a known element type. */
  static fromHostStream<T>(
    host: HostStream<T>,
    codec: ElemCodec<T>,
  ): Stream<T> {
    return new Stream<T>(host, codec);
  }

  /**
   * `Stream.create<T>(): { stream, writer }` — the writer-side host end the
   * contract names.
   *
   * The element type is deliberately NOT a parameter: the embedder does not
   * have one (a `ValType` is a runtime-internal shape) and the *lowering site*
   * always does. So the shared object is created lazily, at the moment the
   * stream is passed to a guest, and writer operations issued before that park
   * until then. A stream created and written but never passed anywhere simply
   * never completes — the same honest hang the low-level layer documents.
   */
  static create<T>(): { stream: Stream<T>; writer: StreamWriter<T> } {
    const stream = new Stream<T>(null, null);
    return { stream, writer: new StreamWriter<T>(stream) };
  }

  /** @internal — bind a lazily created stream to the lowering site's type. */
  bindElement(codec: ElemCodec<T>): void {
    if (this.#host !== null) return;
    this.#codec = codec;
    this.#host = hostStream<T>(codec.element);
    publishHostStream(this, this.#host);
    const waiters = this.#binders;
    this.#binders = [];
    for (const w of waiters) w();
  }

  /** @internal — resolve once this handle has a shared object. */
  whenBound(): Promise<void> {
    if (this.#host !== null) return Promise.resolve();
    return new Promise<void>((r) => this.#binders.push(r));
  }

  /** @internal */
  get bound(): boolean {
    return this.#host !== null;
  }

  /** @internal — the shared value to hand to a lowering site. */
  takeValue(codec: ElemCodec<T>): ComponentValue {
    this.bindElement(codec);
    if (this.#consumed) {
      throw new TypeError(
        "this Stream handle has already been passed to a guest; a stream " +
          "value may only be transferred once",
      );
    }
    this.#consumed = true;
    return this.#host!.value;
  }

  /** @internal */
  get codec(): ElemCodec<T> | null {
    return this.#codec;
  }

  #require(): HostStream<T> {
    if (this.#host === null) {
      throw new TypeError(
        "this Stream was created with Stream.create() and has not been " +
          "passed to a guest yet, so it has no element type; pass it first, " +
          "or use the writer, which parks until then",
      );
    }
    return this.#host;
  }

  /** Low-level read: up to `max` elements; an empty chunk means end-of-stream. */
  async read(max: number): Promise<Chunk<T>> {
    const host = this.#require();
    const where = this.#codec?.where ?? "stream read";
    throwIfFailed(host.value, where);
    const raw = await host.readable.read(max) as unknown as
      | ComponentValue[]
      | Uint8Array;
    // An empty chunk normally means clean end-of-stream; when the peer's
    // instance trapped it means the retirement walk settled us — reject
    // instead of faking EOS (amendment A7). A non-empty chunk was really
    // copied before the trap and is delivered; the next read rejects.
    if (raw.length === 0) throwIfPeerTrapped(host.value, where);
    return this.#chunk(raw);
  }

  #chunk(raw: ComponentValue[] | Uint8Array): Chunk<T> {
    const codec = this.#codec!;
    if (isU8Element(codec.element)) {
      // The exec layer already resolves u8 reads as a Uint8Array (the
      // rendezvous copy itself — issue #54); pass it through untouched so a
      // host read costs exactly that one copy. Uint8Array.from covers
      // raw-layer writers that fed plain arrays.
      return (raw instanceof Uint8Array
        ? raw
        : Uint8Array.from(raw as number[])) as Chunk<T>;
    }
    const vs = raw instanceof Uint8Array ? Array.from(raw) : raw;
    return vs.map((v) => codec.toHost(v as ComponentValue)) as Chunk<T>;
  }

  /** Cancel an in-flight `read` (R-fix review advisory 1). */
  cancelRead(): void {
    this.#host?.readable.cancelRead();
  }

  drop(): void {
    if (this.#dropped) return;
    this.#dropped = true;
    // Both ends of a host wrapper name the same shared object; dropping once
    // is enough (`SharedStreamImpl.drop` is idempotent).
    this.#host?.readable.drop();
  }

  /**
   * @internal — teardown after a trapping import abandoned this handle
   * (#66, instantiate.ts `releaseAsyncArgs`). Unlike `drop()`, this goes
   * through `dropSharedForTeardown`, whose parked-side discipline never
   * wakes the about-to-be-poisoned caller (review B2: a plain drop queued a
   * DROPPED event into the trapping instance's waitables, and a later
   * driving loop asserted on the corpse).
   *
   * Known asymmetry (review advisory, non-blocking): unlike
   * `readable.drop()`, this path does not close the wrapper's HostActivity
   * arm when nothing was parked, so the arm can outlive the stream on an
   * already-faulted store — at worst misreporting a later genuine deadlock
   * as the documented hang, on a store that has already trapped.
   */
  dropForTeardown(): void {
    if (this.#dropped) return;
    this.#dropped = true;
    if (this.#host !== null) {
      dropSharedForTeardown(this.#host.value as never);
    }
  }

  [Symbol.dispose](): void {
    this.drop();
  }

  /** Web-native view: `ReadableStream<Chunk<T>>`. */
  readable(): ReadableStream<Chunk<T>> {
    const self = this;
    return new ReadableStream<Chunk<T>>({
      async pull(controller) {
        const chunk = await self.read(READ_CHUNK);
        if ((chunk as { length: number }).length === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        self.drop();
      },
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Chunk<T>> {
    for (;;) {
      const chunk = await this.read(READ_CHUNK);
      if ((chunk as { length: number }).length === 0) return;
      yield chunk;
    }
  }
}

/** How many elements a convenience read asks for at a time. */
const READ_CHUNK = 4096;

/** Writer half of `Stream.create()`. */
export class StreamWriter<T> {
  #stream: Stream<T>;

  constructor(stream: Stream<T>) {
    this.#stream = stream;
  }

  /**
   * Offer values; resolves with how many the reader took.
   *
   * `Chunk<T>` mirrors the read side: a u8 stream accepts a `Uint8Array`
   * (taken as already-lowered bytes), and a plain array of any element type
   * is lowered per element. u8 chunks travel as `Uint8Array` all the way to
   * the CABI store's bulk path (issue #54) — which makes a `Uint8Array`
   * chunk a BORROW until the returned promise settles; mutating it in that
   * window is misuse. Plain-array chunks are lowered (copied) up front.
   */
  async write(values: Chunk<T>): Promise<number> {
    await this.#stream.whenBound();
    const host = hostOf(this.#stream);
    const where = this.#stream.codec?.where ?? "stream write";
    throwIfFailed(host.value, where);
    const n = await host.writable.write(
      packChunk(values, this.#stream.codec!) as unknown as T[],
    );
    // A short take normally means "re-offer later" / "reader done"; when the
    // reader's instance trapped it means the retirement walk settled us —
    // reject, carrying the delivered count (amendment A7). A full take
    // genuinely completed before the trap and stays a success.
    if (n < values.length) throwIfPeerTrapped(host.value, where, n);
    return n;
  }

  /** Offer values until all are taken or the reader goes away. */
  async writeAll(values: Chunk<T>): Promise<number> {
    await this.#stream.whenBound();
    const host = hostOf(this.#stream);
    const where = this.#stream.codec?.where ?? "stream write";
    throwIfFailed(host.value, where);
    const n = await host.writable.writeAll(
      packChunk(values, this.#stream.codec!) as unknown as T[],
    );
    if (n < values.length) throwIfPeerTrapped(host.value, where, n);
    return n;
  }

  cancelWrite(): void {
    if (!this.#stream.bound) return;
    hostOf(this.#stream).writable.cancelWrite();
  }

  /** End-of-stream. */
  async close(): Promise<void> {
    await this.#stream.whenBound();
    hostOf(this.#stream).writable.drop();
  }
}

const hostOfStream = new WeakMap<Stream<unknown>, HostStream<unknown>>();

function hostOf<T>(s: Stream<T>): HostStream<T> {
  // The host end lives behind `Stream`'s private field; `takeValue`/`read`
  // are the public routes. The writer needs the writable half, so the handle
  // publishes it here at bind time.
  const h = hostOfStream.get(s as Stream<unknown>);
  if (h === undefined) {
    throw new TypeError("stream writer used before the stream was bound");
  }
  return h as HostStream<T>;
}

/** @internal — publish the host end for `StreamWriter` (see `hostOf`). */
export function publishHostStream<T>(s: Stream<T>, h: HostStream<T>): void {
  hostOfStream.set(s as Stream<unknown>, h as HostStream<unknown>);
}

/**
 * A future handle. `await`able directly (`PromiseLike`), and droppable.
 *
 * A future whose write end dropped without ever writing rejects with
 * `DroppedError` — not `undefined`, which `future<void>` legitimately yields.
 */
export class Future<T> implements PromiseLike<T> {
  /** Present once the underlying host end exists. */
  #host: HostFuture<T> | null;
  /** Always present; resolves to the host end (immediately, when not deferred). */
  #hostP: Promise<HostFuture<T>>;
  #codec: ElemCodec<T>;
  #consumed = false;
  #settled: Promise<T> | null = null;

  private constructor(
    host: HostFuture<T> | null,
    hostP: Promise<HostFuture<T>>,
    codec: ElemCodec<T>,
  ) {
    this.#host = host;
    this.#hostP = hostP;
    this.#codec = codec;
  }

  static fromLifted<T>(value: ComponentValue, codec: ElemCodec<T>): Future<T> {
    const h = hostFutureFor<T>(value);
    return new Future<T>(h, Promise.resolve(h), codec);
  }

  static fromHostFuture<T>(
    host: HostFuture<T>,
    codec: ElemCodec<T>,
  ): Future<T> {
    return new Future<T>(host, Promise.resolve(host), codec);
  }

  /**
   * A future that is still in flight: the guest call that produces it has not
   * resolved yet.
   *
   * CONTRACT (contracts/embedder-api.md): §"Functions and async" makes every
   * export Promise-shaped, and §"Streams and futures" makes `Future<T>` a
   * `PromiseLike<T>`. For an export whose *result* is a `future<T>` those two
   * collide irreducibly: JS promise resolution unconditionally adopts a
   * thenable, so `await someExport()` can never hand back a thenable handle —
   * it hands back the value the handle would have yielded. Conservative
   * reading, implemented here: the export returns the handle **eagerly** (it
   * is itself PromiseLike, so `await` still works and still yields `T`), which
   * keeps `drop()`/`cancel()` reachable for a caller that does not await. The
   * alternative — resolving a Promise *to* the handle — is not expressible.
   * Flagged in the C2 report.
   */
  static deferred<T>(
    pending: Promise<ComponentValue>,
    codec: ElemCodec<T>,
  ): Future<T> {
    const f: Future<T> = new Future<T>(
      null,
      pending.then((v) => {
        const h = hostFutureFor<T>(v);
        (f as unknown as { adopt(h: HostFuture<T>): void }).adopt(h);
        return h;
      }),
      codec,
    );
    return f;
  }

  /** @internal */
  adopt(h: HostFuture<T>): void {
    this.#host = h;
  }

  /** @internal */
  takeValue(): ComponentValue {
    if (this.#host === null) {
      throw new TypeError(
        "this Future is still in flight and cannot be passed to a guest yet",
      );
    }
    if (this.#consumed) {
      throw new TypeError(
        "this Future handle has already been passed to a guest",
      );
    }
    this.#consumed = true;
    return this.#host.value;
  }

  #read(): Promise<T> {
    this.#settled ??= (async () => {
      const host = await this.#hostP;
      const { value, result } = await host.readResult();
      if (result !== CopyResult.COMPLETED) {
        // A drop caused by the writer's instance trapping is a fault, not a
        // "no value" outcome — brand it (#66, amendment A7).
        throwIfPeerTrapped(host.value, this.#codec.where ?? "future read");
        throw new DroppedError(
          result === CopyResult.CANCELLED
            ? "the future read was cancelled"
            : "the future's write end was dropped without a value",
        );
      }
      return this.#codec.toHost(value as ComponentValue);
    })();
    return this.#settled;
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.#read().then(onfulfilled, onrejected);
  }

  cancel(): void {
    if (this.#host !== null) this.#host.cancel();
    else void this.#hostP.then((h) => h.cancel());
  }

  drop(): void {
    if (this.#host !== null) this.#host.drop();
    else void this.#hostP.then((h) => h.drop());
  }

  /** @internal — see `Stream.dropForTeardown` (#66). */
  dropForTeardown(): void {
    if (this.#host !== null) {
      dropSharedForTeardown(this.#host.value as never);
    } else {
      // A deferred future (still in flight) cannot be an import argument;
      // fall back to the plain drop for completeness.
      this.drop();
    }
  }

  [Symbol.dispose](): void {
    this.drop();
  }
}

/**
 * `error-context` as the contract spells it: `{ readonly message: string }`.
 * The internal value is `task/streams.ts`'s `ErrorContext` (debug message
 * only, per definitions.py).
 */
export class ErrorContext {
  readonly message: string;
  /** @internal — the internal value, preserved so it can be lowered back. */
  readonly internal: InternalErrorContext;

  constructor(internal: InternalErrorContext) {
    this.internal = internal;
    this.message = internal.debugMessage;
  }
}

/** Anything the layer accepts where a guest expects `stream<T>`. */
export type StreamSource<T> =
  | Stream<T>
  | ReadableStream<T[] | Uint8Array | T>
  | AsyncIterable<T[] | Uint8Array | T>
  | Iterable<T>;

/** Anything the layer accepts where a guest expects `future<T>`. */
export type FutureSource<T> = Future<T> | PromiseLike<T> | T;

/**
 * Adapt a producer to a lowered `stream<T>` value, and own the pumping.
 *
 * The driving arm auto-closes on end (the pump drops the write end when the
 * producer is exhausted) and on `DROPPED` (host_streams settles the activity
 * arm) — R-fix review advisory 2, the deadlock-masking activity-lifetime
 * footgun.
 */
export function lowerStreamSource<T>(
  src: StreamSource<T>,
  codec: ElemCodec<T>,
): ComponentValue {
  if (src instanceof Stream) {
    return src.takeValue(codec);
  }
  const host = hostStream<T>(codec.element);
  const stream = Stream.fromHostStream<T>(host, codec);
  publishHostStream(stream, host);
  void pump(src, host, codec);
  return host.value;
}

/**
 * Lower one chunk of stream elements.
 *
 * u8 chunks come out as `Uint8Array` — either the caller's own (bytes are
 * already canonical component values; issue #54's bulk-store path picks the
 * typed array up unchanged at the rendezvous) or packed from a validated
 * plain array. A `Uint8Array` offered to a NON-u8 stream keeps the legacy
 * behavior: elements are fed through the per-element codec like any array.
 */
function packChunk<T>(
  values: readonly T[] | Uint8Array,
  codec: ElemCodec<T>,
): ComponentValue[] | Uint8Array {
  const u8 = isU8Element(codec.element);
  if (values instanceof Uint8Array) {
    if (u8) return values;
    return Array.from(values as ArrayLike<unknown>).map((v) =>
      codec.fromHost(v as T)
    ) as ComponentValue[];
  }
  const lowered = (values as readonly T[]).map((v) => codec.fromHost(v));
  return u8
    ? Uint8Array.from(lowered as number[])
    : (lowered as ComponentValue[]);
}

async function pump<T>(
  src: Exclude<StreamSource<T>, Stream<T>>,
  host: HostStream<T>,
  codec: ElemCodec<T>,
): Promise<void> {
  const where = codec.where ?? "stream producer";
  let failure: unknown;
  let produced = 0;
  try {
    for await (const batch of batches<T>(src)) {
      // Lowering is the likeliest failure (a value of the wrong shape) and it
      // must be attributed to the site, not swallowed into a short stream.
      const lowered = packChunk(batch, codec) as unknown as T[];
      const n = await host.writable.writeAll(lowered);
      produced += n;
      if (n < lowered.length) break; // the reader went away: a clean end
    }
  } catch (e) {
    failure = e;
  }
  if (failure !== undefined) {
    void produced;
    // Report BEFORE dropping: the drop is what lets the guest see
    // end-of-stream and resolve, and the driving loop checks `hostFailure`
    // before it checks `done()`.
    reportProducerFailure(
      host as unknown as HostStream<unknown>,
      where,
      failure,
    );
  }
  // End of production == end of stream. Dropping unconditionally is what keeps
  // the activity arm from outliving the data (R-fix advisory 2) and what stops
  // a failed producer from hanging the guest forever; the failure has already
  // been recorded on the store, so the call fails rather than resolving.
  host.writable.drop();
}

/** Normalize every accepted producer shape to an async iterator of batches. */
async function* batches<T>(
  src: Exclude<StreamSource<T>, Stream<T>>,
): AsyncGenerator<T[] | Uint8Array> {
  if (isReadableStream(src)) {
    const reader = src.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield asBatch<T>(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (Symbol.asyncIterator in (src as object)) {
    for await (const v of src as AsyncIterable<unknown>) yield asBatch<T>(v);
    return;
  }
  for (const v of src as Iterable<T>) yield asBatch<T>(v);
}

function asBatch<T>(v: unknown): T[] | Uint8Array {
  // Kept whole: `packChunk` decides whether the bytes are already lowered
  // (u8 element) or need the per-element codec (any other element type).
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v as T[];
  return [v as T];
}

function isReadableStream(v: unknown): v is ReadableStream<unknown> {
  return typeof ReadableStream !== "undefined" && v instanceof ReadableStream;
}

/** Adapt a `Promise`/`Future`/plain value to a lowered `future<T>` value. */
export function lowerFutureSource<T>(
  src: FutureSource<T>,
  codec: ElemCodec<T>,
): ComponentValue {
  if (src instanceof Future) return src.takeValue();
  const host = hostFuture<T>(codec.element);
  void (async () => {
    try {
      const v = await (src as PromiseLike<T>);
      await host.write(codec.fromHost(v) as unknown as T);
    } catch (e) {
      // The producer failed. `future<T>` has no error channel of its own, so
      // the guest could only ever see a bare drop — the cause goes on the
      // store's host-failure channel instead, exactly as for streams, so the
      // in-flight call fails with a site-named error.
      //
      // And then we do NOT drop: a host future's write end dropping while the
      // guest's readable end is parked trips an internal invariant in the
      // future built-ins ("a readable future end cannot observe DROPPED",
      // intrinsics/stream_builtins.ts) — a runtime-core matter outside this
      // layer. Leaving the guest parked is harmless because the failure is
      // already recorded: the driving loop of the call raises it before the
      // call can complete. Only when there is NO store to report to (the
      // future was never lowered) do we fall back to dropping, so nothing can
      // hang forever.
      const reported = reportProducerFailure(
        { value: host.value } as unknown as HostStream<unknown>,
        codec.where ?? "future producer",
        e,
      );
      if (!reported) host.drop();
    }
  })();
  return host.value;
}
