// The embedder-facing error model (contracts/embedder-api.md §"Error model").
//
// Three classes, three meanings, no overlap:
//
//   * `WitError` — a WIT `result<T, E>` err **value**. The only thing that
//     crosses the boundary as an err. Branding is the point: under jco any
//     stray `TypeError` from a host import was fed to the lift, so every
//     consumer wrapped every platform call defensively (webcrypto.js's
//     `platformCall`). Here an unbranded throw is a host bug and becomes a
//     trap, so the defensive wrapper is unnecessary by construction.
//   * `Trap`   — component-fatal, never a value (re-exported from cabi).
//   * `DroppedError` — awaiting a future whose write end dropped without a
//     value (R-fix review note 4).

export { Trap } from "../cabi/trap.ts";

/** A WIT `result<T, E>` err value, branded. `payload` is shaped per the value table. */
export class WitError<E = unknown> extends Error {
  readonly payload: E;

  constructor(payload: E, message?: string) {
    super(message ?? `WIT error: ${describePayload(payload)}`);
    this.name = "WitError";
    this.payload = payload;
  }
}

/**
 * Awaiting a `Future<T>` whose write end dropped without ever writing.
 *
 * Discriminated on purpose: "no value, ever" is a different outcome from
 * "the value was `undefined`" (`future<void>`), and a consumer that must tell
 * them apart should not have to guess from a sentinel.
 */
export class DroppedError extends Error {
  constructor(message = "the write end was dropped without a value") {
    super(message);
    this.name = "DroppedError";
  }
}

/**
 * Two WIT labels in one scope camelCase to the same JS name.
 *
 * A footgun is a design defect (contract principle 2): silently letting one
 * field/flag/function shadow another would corrupt values at the boundary with
 * no diagnostic anywhere. Refused at facade build instead.
 */
export class NameCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameCollisionError";
  }
}

/** Use of a resource wrapper whose handle was transferred away or dropped. */
export class InvalidHandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHandleError";
  }
}

function describePayload(p: unknown): string {
  if (p === null || p === undefined) return String(p);
  if (typeof p === "object" && "tag" in (p as Record<string, unknown>)) {
    return String((p as { tag: unknown }).tag);
  }
  if (typeof p === "object") return JSON.stringify(p);
  return String(p);
}
