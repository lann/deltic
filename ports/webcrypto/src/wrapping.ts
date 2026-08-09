// `polymorph:webcrypto/wrapping` — wit/wrapping.wit `interface wrapping`.
//
// Provider-held intermediates for key wrapping: `wrap-input` (serialized key
// material awaiting encryption) and `unwrap-input` (decrypted material
// awaiting a typed mint). Both are per-instance and consumed exactly once —
// consumption removes the state before anything else runs, on failure as on
// success (the WIT contract), mirroring the reference's `consumeWrapInput`/
// `consumeUnwrapInput` (js/jco/webcrypto.js:1194-1214).
//
// Per contracts/embedder-api.md §"Resources", host-implemented resources are
// plain classes; the runtime (not this port) owns handle identity. State
// lives in module-private WeakMaps rather than public fields so the bytes
// never become guest-readable through the class shape.

import { errOther } from "./errors.ts";

export type WrapFormat = "raw" | "jwk" | "pkcs8";

const wrapState = new WeakMap<WrapInput, { format: WrapFormat; bytes: Uint8Array }>();
const unwrapState = new WeakMap<UnwrapInput, { bytes: Uint8Array }>();

/** `wrapping.wrap-input`: serialized key material awaiting a wrap. */
export class WrapInput {
  constructor(format: WrapFormat, bytes: Uint8Array) {
    wrapState.set(this, { format, bytes });
  }
}

/** `wrapping.unwrap-input`: decrypted key material awaiting a typed mint. */
export class UnwrapInput {
  constructor(bytes: Uint8Array) {
    unwrapState.set(this, { bytes });
  }
}

/** Consume a `wrap-input`; a miss means already-consumed or foreign. */
export function consumeWrapInput(input: WrapInput): { format: WrapFormat; bytes: Uint8Array } {
  const state = wrapState.get(input);
  wrapState.delete(input);
  if (state === undefined) {
    errOther("wrap-input already consumed or minted by another provider");
  }
  return state;
}

/** Consume an `unwrap-input`; see `consumeWrapInput`. */
export function consumeUnwrapInput(input: UnwrapInput): { bytes: Uint8Array } {
  const state = unwrapState.get(input);
  unwrapState.delete(input);
  if (state === undefined) {
    errOther("unwrap-input already consumed or minted by another provider");
  }
  return state;
}

/** The `polymorph:webcrypto/wrapping@0.1.0` interface: its resource classes. */
export const wrapping = { WrapInput, UnwrapInput };
