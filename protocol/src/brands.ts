// The process-global brand vocabulary (contracts/embedder-api.md
// §"Module identity and @deltic/protocol", amendment A9; issue #83).
//
// Every brand is a `Symbol.for` REGISTRY symbol, so N copies of this package
// (or of the runtime) agree on every brand by construction — no module
// sharing, no `instanceof`, no resolution discipline required. That is the
// whole point: source distribution with no registry dedup means a consumer
// graph can carry several runtime copies (wosh finding 26 carried four), and
// class identity fails there *latently*, on the first error path only.
//
// Keys are generation-suffixed (`/1`). Bumping a generation is a BREAKING
// vocabulary change — an ecosystem migration event, the moral equivalent of a
// semver major — which is why protocol/tests/brands_test.ts pins every key
// string literally.
//
// Brands are contract markers, NOT a security boundary: a hand-rolled object
// carrying the right symbol is a legal value (this is what makes zero-import
// host modules possible). The canonical classes are conveniences.

/**
 * `ComponentException` — a WIT `result<T, E>` err value.
 *
 * The key string keeps its pre-A10 name (`witError`) deliberately: it is an
 * opaque wire constant, CEWD-style (same precedent as bindgen's CEWD name),
 * so pre-A10 copies and hand-rolled brands keep interoperating. Only the
 * exported TS identifier renamed with the class (contracts/embedder-api.md
 * amendment A10).
 */
export const COMPONENT_EXCEPTION: unique symbol = Symbol.for(
  "deltic.witError/1",
);
/** `Trap` — component-fatal, never a value. */
export const TRAP: unique symbol = Symbol.for("deltic.trap/1");
/** `DroppedError` — a dropped-future rejection. */
export const DROPPED: unique symbol = Symbol.for("deltic.dropped/1");
/** `PeerTrappedError` — a peer-fault rejection (amendment A7). */
export const PEER_TRAPPED: unique symbol = Symbol.for(
  "deltic.peerTrapped/1",
);
/** `InvalidHandleError` — resource-wrapper misuse. */
export const INVALID_HANDLE: unique symbol = Symbol.for(
  "deltic.invalidHandle/1",
);
/** `StreamProducerError` — a producer-side failure. */
export const STREAM_PRODUCER: unique symbol = Symbol.for(
  "deltic.streamProducer/1",
);
/** The per-declaration suspendability mark (amendments A1/A2). */
export const SUSPENDING: unique symbol = Symbol.for(
  "deltic.suspending/1",
);
/** `Stream.prototype` — embedder stream handles (stateful: foreign = refused). */
export const STREAM: unique symbol = Symbol.for("deltic.stream/1");
/** `Future.prototype` — embedder future handles (stateful: foreign = refused). */
export const FUTURE: unique symbol = Symbol.for("deltic.future/1");
/** Lifted error-contexts (stateful: foreign = refused). */
export const ERROR_CONTEXT: unique symbol = Symbol.for(
  "deltic.errorContext/1",
);
/**
 * Guest-resource wrappers: the KEY for the wrapper's internal state. Only the
 * key is contract; the state SHAPE stays runtime-internal (A9 table note), so
 * a foreign copy can *recognize* a wrapper but never read its state.
 */
export const RESOURCE_STATE: unique symbol = Symbol.for(
  "deltic.resourceState/1",
);
/** `Pollable.prototype` (wasi-shims). */
export const POLLABLE: unique symbol = Symbol.for("deltic.pollable/1");
/** `ExitError.prototype` (wasi-shims) — wasi exit unwinds. */
export const WASI_EXIT: unique symbol = Symbol.for(
  "deltic.wasiExit/1",
);
/** The copy registry array, on `globalThis`. */
export const RUNTIME_COPIES: unique symbol = Symbol.for(
  "deltic.runtimeCopies/1",
);

/**
 * The brand generation this package speaks. Recorded per copy in the registry
 * so a future generation bump is diagnosable rather than silent.
 */
export const PROTOCOL_GENERATION = 1;

/**
 * Brand check. True iff `value` is a non-null object (or function — the
 * suspending mark rides functions) carrying `brand` set to exactly `true`.
 *
 * Deliberately structural: it accepts hand-rolled brands and values minted by
 * any copy. It never consults `instanceof` — that is the failure mode A9
 * exists to remove.
 */
export function hasBrand(value: unknown, brand: symbol): boolean {
  if (value === null) return false;
  const t = typeof value;
  if (t !== "object" && t !== "function") return false;
  return (value as Record<symbol, unknown>)[brand] === true;
}

/**
 * Stamp a brand on a prototype (or any object): non-enumerable and
 * non-writable, so it never shows up in value walks, `JSON.stringify`, or
 * spread, and cannot be clobbered by assignment.
 *
 * Idempotent by construction is NOT free with `defineProperty` on a
 * non-configurable property, so this is written to be called exactly once per
 * prototype at module evaluation; a second call with the same value is
 * tolerated by leaving the existing definition alone.
 */
export function defineBrand(target: object, brand: symbol): void {
  if (Object.prototype.hasOwnProperty.call(target, brand)) return;
  Object.defineProperty(target, brand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}
