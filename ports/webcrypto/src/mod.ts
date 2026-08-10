// The `polymorph:webcrypto@0.1.0` host-module port: `webcryptoImports()`
// returns the imports-record fragment for `instantiate` (contracts/
// embedder-api.md §"Naming and casing": interface keys are the fully
// qualified WIT id, version included).
//
// Ported interfaces — the package's WHOLE surface as of 0.1.0:
//   types (error taxonomy only; no exported functions),
//   digest + sha2, sha1-checked (declined; see below),
//   mac + hmac-sha1/hmac-sha2,
//   signature + ed25519-verify/-sign, ecdsa-verify/-sign,
//     rsassa-pkcs1-v15-verify/-sign, rsa-pss-verify/-sign,
//   key-agreement + x25519, ecdh,
//   derivation, wrapping,
//   hkdf + hkdf-sha1/hkdf-sha2, pbkdf2 + pbkdf2-sha1/pbkdf2-sha2,
//   aead + aes-gcm, cipher + aes-cbc/aes-ctr, key-wrap + aes-kw,
//   public-encryption + rsa-oaep-encrypt/rsa-oaep-decrypt.
//
// Two standing declines, both the WIT's own rulings rather than Deno gaps:
//   - `sha1-checked` is provided but fail-closed: its postures need sha1dc
//     collision detection, which no platform WebCrypto carries (see
//     sha1Checked.ts). Conformance targets declare it in missing-features.
//   - `aes192`, `p521`/`p521-sha512`, and the truncated SHA-2 variants are
//     declined package-wide with `error.unsupported` (see the WIT docs).
//
// The RSA private-key posture (`rsa-pss-sign`, `rsassa-pkcs1-v15-sign`,
// `rsa-oaep-decrypt`) defaults to SERVED here, matching the reference's
// Node posture; a browser-hosted embedding should call
// `setRsaPrivateKeyPolicy("decline")` — see rsaSignature.ts.

import { digest, sha2 } from "./digest.ts";
import { sha1Checked } from "./sha1Checked.ts";
import { hmacSha1, hmacSha2, mac } from "./mac.ts";
import { ed25519Sign, ed25519Verify, signature } from "./signature.ts";
import { ecdsaSign, ecdsaVerify } from "./ecdsa.ts";
import { rsaPssSign, rsaPssVerify, rsassaPkcs1V15Sign, rsassaPkcs1V15Verify } from "./rsaSignature.ts";
import { keyAgreement, x25519 } from "./keyAgreement.ts";
import { ecdh } from "./ecdh.ts";
import { derivation } from "./derivation.ts";
import { wrapping } from "./wrapping.ts";
import { hkdf, hkdfSha1, hkdfSha2 } from "./hkdf.ts";
import { pbkdf2, pbkdf2Sha1, pbkdf2Sha2 } from "./pbkdf2.ts";
import { aead, aesGcm } from "./aead.ts";
import { aesCbc, aesCtr, cipher } from "./cipher.ts";
import { aesKw, keyWrap } from "./keyWrap.ts";
import { publicEncryption, rsaOaepDecrypt, rsaOaepEncrypt } from "./publicEncryption.ts";

export { Digest, sha2 } from "./digest.ts";
export { sha1Checked } from "./sha1Checked.ts";
export { hmacSha1, hmacSha2, MacKey, MacKeyOptions } from "./mac.ts";
export {
  ed25519Sign,
  ed25519Verify,
  type SignatureAlgorithm,
  SigningKey,
  SigningKeyOptions,
  VerifyingKey,
} from "./signature.ts";
export { ecdsaSign, ecdsaVerify } from "./ecdsa.ts";
export {
  rsaPssSign,
  rsaPssVerify,
  rsassaPkcs1V15Sign,
  rsassaPkcs1V15Verify,
  setRsaPrivateKeyPolicy,
} from "./rsaSignature.ts";
export { AgreementKeyOptions, keyAgreement, PublicKey, SecretKey, x25519 } from "./keyAgreement.ts";
export { ecdh } from "./ecdh.ts";
export { DeriveInput, DeriveOptions, derivation } from "./derivation.ts";
export { UnwrapInput, WrapInput, wrapping } from "./wrapping.ts";
export { hkdf, hkdfSha1, hkdfSha2, Ikm } from "./hkdf.ts";
export { Password, pbkdf2, pbkdf2Sha1, pbkdf2Sha2 } from "./pbkdf2.ts";
export { AeadKey, AeadKeyOptions, aead, aesGcm } from "./aead.ts";
export { aesCbc, aesCtr, cipher, CipherKey, CipherKeyOptions } from "./cipher.ts";
export { aesKw, keyWrap, KwKey, KwKeyOptions } from "./keyWrap.ts";
export {
  DecryptionKey,
  DecryptionKeyOptions,
  EncryptionKey,
  publicEncryption,
  rsaOaepDecrypt,
  rsaOaepEncrypt,
} from "./publicEncryption.ts";
export type { WcErrorPayload } from "./errors.ts";

/**
 * Build the `polymorph:webcrypto@0.1.0` imports fragment for `instantiate`.
 *
 * Usage: `instantiate(artifacts, { ...wasiShims(), ...webcryptoImports() })`
 * — the shape both conformance suites are driven with (see
 * conformance/run.ts and tests/import_surface_test.ts, which asserts this
 * record leaves ZERO import leaves unresolved for either suite).
 */
export function webcryptoImports(): Record<string, unknown> {
  return {
    "polymorph:webcrypto/digest@0.1.0": digest,
    "polymorph:webcrypto/sha2@0.1.0": sha2,
    "polymorph:webcrypto/sha1-checked@0.1.0": sha1Checked,
    "polymorph:webcrypto/mac@0.1.0": mac,
    "polymorph:webcrypto/hmac-sha1@0.1.0": hmacSha1,
    "polymorph:webcrypto/hmac-sha2@0.1.0": hmacSha2,
    "polymorph:webcrypto/signature@0.1.0": signature,
    "polymorph:webcrypto/ed25519-verify@0.1.0": ed25519Verify,
    "polymorph:webcrypto/ed25519-sign@0.1.0": ed25519Sign,
    "polymorph:webcrypto/ecdsa-verify@0.1.0": ecdsaVerify,
    "polymorph:webcrypto/ecdsa-sign@0.1.0": ecdsaSign,
    "polymorph:webcrypto/rsassa-pkcs1-v15-verify@0.1.0": rsassaPkcs1V15Verify,
    "polymorph:webcrypto/rsassa-pkcs1-v15-sign@0.1.0": rsassaPkcs1V15Sign,
    "polymorph:webcrypto/rsa-pss-verify@0.1.0": rsaPssVerify,
    "polymorph:webcrypto/rsa-pss-sign@0.1.0": rsaPssSign,
    "polymorph:webcrypto/key-agreement@0.1.0": keyAgreement,
    "polymorph:webcrypto/x25519@0.1.0": x25519,
    "polymorph:webcrypto/ecdh@0.1.0": ecdh,
    "polymorph:webcrypto/derivation@0.1.0": derivation,
    "polymorph:webcrypto/wrapping@0.1.0": wrapping,
    "polymorph:webcrypto/hkdf@0.1.0": hkdf,
    "polymorph:webcrypto/hkdf-sha2@0.1.0": hkdfSha2,
    "polymorph:webcrypto/hkdf-sha1@0.1.0": hkdfSha1,
    "polymorph:webcrypto/pbkdf2@0.1.0": pbkdf2,
    "polymorph:webcrypto/pbkdf2-sha2@0.1.0": pbkdf2Sha2,
    "polymorph:webcrypto/pbkdf2-sha1@0.1.0": pbkdf2Sha1,
    "polymorph:webcrypto/aead@0.1.0": aead,
    "polymorph:webcrypto/aes-gcm@0.1.0": aesGcm,
    "polymorph:webcrypto/cipher@0.1.0": cipher,
    "polymorph:webcrypto/aes-cbc@0.1.0": aesCbc,
    "polymorph:webcrypto/aes-ctr@0.1.0": aesCtr,
    "polymorph:webcrypto/key-wrap@0.1.0": keyWrap,
    "polymorph:webcrypto/aes-kw@0.1.0": aesKw,
    "polymorph:webcrypto/public-encryption@0.1.0": publicEncryption,
    "polymorph:webcrypto/rsa-oaep-encrypt@0.1.0": rsaOaepEncrypt,
    "polymorph:webcrypto/rsa-oaep-decrypt@0.1.0": rsaOaepDecrypt,
  };
}
