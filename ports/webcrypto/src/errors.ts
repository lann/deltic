// Shared error taxonomy plumbing for the `polymorph:webcrypto` port.
//
// Governing docs:
//   - contracts/embedder-api.md §"Error model" — host imports report a WIT
//     `result<_, error>` err case by throwing `new WitError(payload)`; an
//     UNBRANDED throw becomes a host-fatal trap. That is a deliberate
//     inversion of jco's convention (any stray `TypeError` was fed to the
//     lift), which is why the polymorph reference wraps every platform call
//     in `platformCall` (js/jco/webcrypto.js:234-262): under OUR conventions
//     that wrapper is unnecessary by construction, so this module keeps only
//     the DOMException -> WIT-taxonomy MAPPING, not the defensive scaffold.
//   - wit/webcrypto.wit `interface types` — the closed `error` variant this
//     mapping targets.
//
// `error` is a WIT variant; per the value-mapping table
// (contracts/embedder-api.md §"Value mapping", `variant` row) its payload
// shape is `{ tag, val? }` with `val` absent for payloadless cases.

import { WitError } from "../../../runtime/src/embedder/errors.ts";

/** The `types.error` payload shape (the value-mapping table's variant row). */
export type WcErrorPayload =
  | { tag: "invalid-key"; val: string }
  | { tag: "invalid-nonce"; val: string }
  | { tag: "authentication-failed" }
  | { tag: "not-extractable" }
  | { tag: "unsupported"; val: string }
  | { tag: "not-permitted"; val: string }
  | { tag: "other"; val: string }
  | { tag: "extension"; val: { origin: string; name: string; message: string } };

/** Throw the branded `result<_, error>` err value for a WIT-declared case. */
export function witError(payload: WcErrorPayload): never {
  throw new WitError(payload);
}

export function errInvalidKey(detail: string): never {
  return witError({ tag: "invalid-key", val: detail });
}
export function errInvalidNonce(detail: string): never {
  return witError({ tag: "invalid-nonce", val: detail });
}
export function errAuthenticationFailed(): never {
  return witError({ tag: "authentication-failed" });
}
export function errNotExtractable(): never {
  return witError({ tag: "not-extractable" });
}
export function errUnsupported(detail: string): never {
  return witError({ tag: "unsupported", val: detail });
}
export function errNotPermitted(detail: string): never {
  return witError({ tag: "not-permitted", val: detail });
}
export function errOther(detail: string): never {
  return witError({ tag: "other", val: detail });
}

/** The refusal an operation renders on a usage-denied key (reference parity: js/jco/webcrypto.js:162-164). */
export function notPermitted(operation: string): never {
  return errNotPermitted(`this key does not permit ${operation}`);
}

/** The name/message pair of a caught platform (DOMException-shaped) rejection. */
function asPlatformError(err: unknown): { name: string | undefined; detail: string } {
  const shape = err as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof shape?.name === "string" ? shape.name : undefined;
  const message = typeof shape?.message === "string" ? shape.message : undefined;
  return { name, detail: message ?? String(err) };
}

/**
 * Await a `crypto.subtle` call, mapping a `DOMException` onto the WIT error
 * taxonomy (the reference's `platformCall` DOMException mapping, ported;
 * js/jco/webcrypto.js:251-262). `NotSupportedError` is the WIT's
 * "well-formed request this implementation does not serve"
 * (`error.unsupported`); everything else platform-thrown is operational
 * (`error.other`). Anything already a `WitError` passes through unchanged.
 * An exception that is neither a `WitError` nor DOMException-shaped is a
 * host bug, not a taxonomy case: it is rethrown as-is and becomes a trap
 * per contracts/embedder-api.md's error model, not smuggled into `other`.
 */
export async function platformCall<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof WitError) throw err;
    if (err instanceof DOMException) {
      const { name, detail } = asPlatformError(err);
      if (name === "NotSupportedError") {
        errUnsupported(`${what} is not served by this platform: ${detail}`);
      }
      errOther(`${what} failed: ${detail}`);
    }
    throw err;
  }
}

/**
 * Lift a `subtle.decrypt`/`unwrapKey`-style rejection (reference:
 * js/jco/webcrypto.js `decryptFailure`, lines 182-196). A failed AEAD tag
 * check surfaces as `OperationError`, which is `authentication-failed` and
 * deliberately detail-free (WIT contract: a failed verification MUST report
 * this case and nothing else). Any other DOMException is an operational
 * condition, not a security verdict, so it stays `other` with detail —
 * conflating the two would render a local fault as an attack signal.
 */
export function decryptFailure(err: unknown, operation = "open"): never {
  if (err instanceof DOMException && err.name === "OperationError") {
    errAuthenticationFailed();
  }
  const { detail } = asPlatformError(err);
  errOther(`${operation}: ${detail}`);
}

/** The WebCrypto usages granted by `pairs`, throwing `not-permitted` on an all-false grant (package-wide options contract: mint requires at least one usage). */
export function grantedUsages(pairs: Array<[KeyUsage, boolean]>): KeyUsage[] {
  const usages = pairs.filter(([, granted]) => granted).map(([usage]) => usage);
  if (usages.length === 0) {
    errNotPermitted("a key with no enabled usage cannot be minted");
  }
  return usages;
}
