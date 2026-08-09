// The `polymorph:webcrypto@0.1.0` host-module port: `webcryptoImports()`
// returns the imports-record fragment for `instantiate` (contracts/
// embedder-api.md §"Naming and casing": interface keys are the fully
// qualified WIT id, version included).
//
// Ported interfaces (see the mission report for the full inventory and
// scope cuts): types (error taxonomy only; no exported functions), digest +
// sha2, mac + hmac-sha1/hmac-sha2, signature + ed25519-verify/ed25519-sign,
// key-agreement + x25519, derivation, wrapping, hkdf + hkdf-sha2/hkdf-sha1,
// aead + aes-gcm.
//
// NOT ported (time-boxed scope cut, not a Deno `crypto.subtle` gap): sha1
// -checked (`@unstable`, needs sha1dc — no platform serves it), ecdh,
// ecdsa, pbkdf2, rsa, cipher/aes-cbc/aes-ctr, key-wrap/aes-kw.

import { digest, sha2 } from "./digest.ts";
import { hmacSha1, hmacSha2, mac } from "./mac.ts";
import { ed25519Sign, ed25519Verify, signature } from "./signature.ts";
import { keyAgreement, x25519 } from "./keyAgreement.ts";
import { derivation } from "./derivation.ts";
import { wrapping } from "./wrapping.ts";
import { hkdf, hkdfSha1, hkdfSha2 } from "./hkdf.ts";
import { aead, aesGcm } from "./aead.ts";

export { Digest, sha2 } from "./digest.ts";
export { hmacSha1, hmacSha2, MacKey, MacKeyOptions } from "./mac.ts";
export {
  ed25519Sign,
  ed25519Verify,
  SigningKey,
  SigningKeyOptions,
  VerifyingKey,
} from "./signature.ts";
export { AgreementKeyOptions, keyAgreement, PublicKey, SecretKey, x25519 } from "./keyAgreement.ts";
export { DeriveInput, DeriveOptions, derivation } from "./derivation.ts";
export { UnwrapInput, WrapInput, wrapping } from "./wrapping.ts";
export { hkdf, hkdfSha1, hkdfSha2, Ikm } from "./hkdf.ts";
export { AeadKey, AeadKeyOptions, aead, aesGcm } from "./aead.ts";
export type { WcErrorPayload } from "./errors.ts";

/**
 * Build the `polymorph:webcrypto@0.1.0` imports fragment for `instantiate`.
 *
 * Usage: `instantiate(artifacts, { ...wasiShims(), ...webcryptoImports() })`
 * (the mission's named integration shape — see tests/integration_exec_model_test.ts,
 * the real-port replacement of wasi-shims's test-local `webcryptoFixture()`).
 */
export function webcryptoImports(): Record<string, unknown> {
  return {
    "polymorph:webcrypto/digest@0.1.0": digest,
    "polymorph:webcrypto/sha2@0.1.0": sha2,
    "polymorph:webcrypto/mac@0.1.0": mac,
    "polymorph:webcrypto/hmac-sha1@0.1.0": hmacSha1,
    "polymorph:webcrypto/hmac-sha2@0.1.0": hmacSha2,
    "polymorph:webcrypto/signature@0.1.0": signature,
    "polymorph:webcrypto/ed25519-verify@0.1.0": ed25519Verify,
    "polymorph:webcrypto/ed25519-sign@0.1.0": ed25519Sign,
    "polymorph:webcrypto/key-agreement@0.1.0": keyAgreement,
    "polymorph:webcrypto/x25519@0.1.0": x25519,
    "polymorph:webcrypto/derivation@0.1.0": derivation,
    "polymorph:webcrypto/wrapping@0.1.0": wrapping,
    "polymorph:webcrypto/hkdf@0.1.0": hkdf,
    "polymorph:webcrypto/hkdf-sha2@0.1.0": hkdfSha2,
    "polymorph:webcrypto/hkdf-sha1@0.1.0": hkdfSha1,
    "polymorph:webcrypto/aead@0.1.0": aead,
    "polymorph:webcrypto/aes-gcm@0.1.0": aesGcm,
  };
}
