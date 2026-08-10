// Shared platform-facing helpers for the `polymorph:webcrypto` port: the
// variant-table lookup, the gated exports, the JWK-material plumbing, and
// the two shallow DER guards the WIT contract pins ahead of the platform.
//
// Every function here is a direct port of the consumer's jco host module —
// the behavioral reference named by the mission — with `file:line`
// citations against `polymorph-webcrypto/js/jco/webcrypto.js`. Nothing
// here is fresh cryptographic engineering: the checks exist because the
// WIT pins verdicts the engines disagree on, and the reference is the
// authority for which verdict each is.

import { errInvalidKey, errNotExtractable, errUnsupported, platformCall } from "./errors.ts";
import { WitError } from "../../../runtime/src/embedder/errors.ts";
import { asBufferSource } from "./util.ts";

const subtle = globalThis.crypto.subtle;

/** The served entry of a variant table, or `error.unsupported` (reference: webcrypto.js:286). */
export function served<T>(table: Readonly<Record<string, T | undefined>>, variant: string): T {
  const entry = table[variant];
  if (entry === undefined) {
    errUnsupported(`${variant} is not served by this implementation`);
  }
  return entry;
}

/** The raw key length in bytes per served `aes-variant` (reference: webcrypto.js:2467; aes192 is declined package-wide by the WIT's own portability ruling). */
export const AES_VARIANT_BYTES: Readonly<Record<string, number | undefined>> = Object.freeze({
  aes128: 16,
  aes256: 32,
});

export function aesVariantByteLength(variant: string): number {
  return served(AES_VARIANT_BYTES, variant);
}

/** The mint-bound digest per served `sha2-variant` (reference: webcrypto.js:271). */
export const SHA2_VARIANTS: Readonly<Record<string, { hash: string; digestBytes: number } | undefined>> = Object
  .freeze({
    sha256: { hash: "SHA-256", digestBytes: 32 },
    sha384: { hash: "SHA-384", digestBytes: 48 },
    sha512: { hash: "SHA-512", digestBytes: 64 },
  });

/** The SHA-1 HMAC/KDF entry (reference: webcrypto.js:953). */
export const SHA1_ENTRY = Object.freeze({ hash: "SHA-1", digestBytes: 20 });

/** Rethrow a platform import failure as `error.invalid-key` (reference: webcrypto.js:4478). */
function invalidKey(err: unknown, what: string): never {
  const detail = err instanceof Error ? err.message : String(err);
  errInvalidKey(`invalid ${what}: ${detail}`);
}

/** Import binary key material; a platform refusal is `invalid-key` (reference: webcrypto.js:4495). */
export async function importPlatformKey(
  what: string,
  format: "raw" | "spki" | "pkcs8",
  bytes: Uint8Array,
  // deno-lint-ignore no-explicit-any
  algorithm: any,
  extractable: boolean,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  try {
    return await subtle.importKey(format, asBufferSource(bytes), algorithm, extractable, usages);
  } catch (err) {
    if (err instanceof WitError) throw err;
    invalidKey(err, what);
  }
}

/** Import a parsed JWK (a `jwkMaterial` result) (reference: webcrypto.js:4514). */
export async function importPlatformKeyJwk(
  what: string,
  jwk: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  algorithm: any,
  extractable: boolean,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  try {
    return await subtle.importKey("jwk", jwk as JsonWebKey, algorithm, extractable, usages);
  } catch (err) {
    if (err instanceof WitError) throw err;
    invalidKey(err, what);
  }
}

/** `export-key-raw` behind the extractability gate (reference: webcrypto.js:3708). */
export async function exportRawGated(key: CryptoKey): Promise<Uint8Array> {
  if (!key.extractable) errNotExtractable();
  return new Uint8Array(await platformCall("raw key export", () => subtle.exportKey("raw", key)));
}

/** The `oct` JWK, material members only, behind the same gate (reference: webcrypto.js:3721). */
export async function exportJwkGated(key: CryptoKey): Promise<string> {
  if (!key.extractable) errNotExtractable();
  const jwk = await platformCall("jwk key export", () => subtle.exportKey("jwk", key));
  return JSON.stringify({ kty: jwk.kty, k: jwk.k, alg: jwk.alg });
}

/** The decoded byte length of a valid unpadded-base64url string (reference: webcrypto.js:3733). */
export function jwkKeyBytes(k: unknown): number {
  return typeof k === "string" ? Math.floor((k.length * 3) / 4) : 0;
}

/**
 * The base64url value (0-63) of a code unit, -1 outside the alphabet
 * (reference: webcrypto.js:3748). Branchless sign-bit arithmetic: secret
 * JWK members pass through here, so per-character work stays uniform.
 */
function b64urlValue(code: number): number {
  const inRange = (lo: number, hi: number) => ((lo - 1 - code) & (code - hi - 1)) >>> 31;
  const upper = inRange(0x41, 0x5a);
  const lower = inRange(0x61, 0x7a);
  const digit = inRange(0x30, 0x39);
  const minus = inRange(0x2d, 0x2d);
  const under = inRange(0x5f, 0x5f);
  const valid = upper | lower | digit | minus | under;
  return (
    upper * (code - 0x41) +
    lower * (code - 0x61 + 26) +
    digit * (code - 0x30 + 52) +
    minus * 62 +
    under * 63 -
    (1 - valid)
  );
}

/** Decode strict unpadded base64url, validated first (reference: webcrypto.js:3781). */
export function b64urlDecode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    buffer = (buffer << 6) | b64urlValue(text.charCodeAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * Enforce the contract's strict unpadded base64url on a JWK member before
 * the platform sees it (reference: webcrypto.js:3825): engines are lenient
 * here (Node accepts padding) and the WIT pins strictness, so
 * implementations cannot diverge on adversarial input. Non-string members
 * pass through — the platform rejects them with the right error shape.
 */
export function requireStrictBase64url(k: unknown): void {
  if (typeof k !== "string") return;
  if (k.length % 4 === 1) {
    errInvalidKey("JWK member has an impossible base64url length");
  }
  let invalid = 0;
  let last = 0;
  for (let i = 0; i < k.length; i++) {
    const value = b64urlValue(k.charCodeAt(i));
    invalid |= value >> 31;
    last = value;
  }
  if (invalid !== 0) {
    errInvalidKey("JWK member is not unpadded base64url");
  }
  const rem = k.length % 4;
  if (rem !== 0) {
    const mask = rem === 2 ? 0b1111 : 0b11;
    if ((last & mask) !== 0) {
      errInvalidKey("JWK member has non-zero trailing bits");
    }
  }
}

/**
 * Parse JWK JSON text and strip the members the WIT contract ignores
 * (reference: webcrypto.js:3863). `use`/`key_ops` are consumer policy and
 * must not reach the platform, whose import would otherwise enforce them
 * against the usages this host passes; `ext` stays (the platform validates
 * it against `extractable`, which the WIT does model).
 */
export function jwkMaterial(jwkText: string): Record<string, unknown> {
  let jwk: unknown;
  try {
    jwk = JSON.parse(jwkText);
  } catch (err) {
    errInvalidKey(`JWK is not valid JSON: ${err}`);
  }
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) {
    errInvalidKey("JWK must be a JSON object");
  }
  const { use: _use, key_ops: _keyOps, ...material } = jwk as Record<string, unknown>;
  return material;
}

/**
 * Run an unwrap mint's import body, redacting the detail of any
 * `invalid-key` failure (reference: webcrypto.js:1227): the parse input is
 * decrypted key material the caller does not hold, so the message must not
 * carry any of it.
 */
export async function redactingInvalidKey<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof WitError && (err.payload as { tag?: string })?.tag === "invalid-key") {
      errInvalidKey(`invalid ${what}`);
    }
    throw err;
  }
}

/**
 * The offset of the AlgorithmIdentifier TLV inside a SubjectPublicKeyInfo,
 * or 0 when the input does not open as one (reference: webcrypto.js:2139).
 */
function spkiAlgorithmOffset(spki: Uint8Array): number {
  if (spki.length >= 2 && spki[0] === 0x30) {
    const first = spki[1];
    if (first < 0x80) return 2;
    if (first === 0x81 && spki.length >= 3 && spki[2] >= 0x80) return 3;
    if (first === 0x82 && spki.length >= 4 && spki[2] !== 0) return 4;
  }
  return 0;
}

/** The named-curve AlgorithmIdentifier TLVs (reference: webcrypto.js:2118). */
const EC_SPKI_ALGORITHM_IDENTIFIERS: Readonly<Record<string, Uint8Array>> = Object.freeze({
  "P-256": Uint8Array.from([
    0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x03, 0x01, 0x07,
  ]),
  "P-384": Uint8Array.from([
    0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04,
    0x00, 0x22,
  ]),
});

/**
 * Reject an EC SubjectPublicKeyInfo whose AlgorithmIdentifier is not the
 * declared curve's named-OID form (reference: webcrypto.js:2166). Engines
 * split on explicit-ECParameters encodings and the WIT pins their
 * rejection; the check is shallow and fail-closed, so it can only
 * over-reject — whatever it passes still gets the platform's full DER
 * validation. Vector coverage: the Wycheproof `UnnamedCurve` family.
 */
export function requireNamedCurveSpki(namedCurve: string, spki: Uint8Array): void {
  const algorithm = EC_SPKI_ALGORITHM_IDENTIFIERS[namedCurve];
  const offset = spkiAlgorithmOffset(spki);
  if (algorithm === undefined || offset === 0 || !algorithm.every((byte, i) => spki[offset + i] === byte)) {
    errInvalidKey(`${namedCurve} SPKI must name the curve by OID`);
  }
}

/** `SEQUENCE { rsaEncryption, NULL }` (reference: webcrypto.js:2185). */
const RSA_SPKI_ALGORITHM_IDENTIFIER = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/**
 * Reject an RSA SubjectPublicKeyInfo that is not the `rsaEncryption` form
 * (reference: webcrypto.js:2197): the family admission contract pins
 * rejection of SPKIs carrying `id-RSASSA-PSS` parameters as `invalid-key`,
 * uniformly regardless of engine behavior.
 */
export function requireRsaEncryptionSpki(spki: Uint8Array): void {
  const offset = spkiAlgorithmOffset(spki);
  if (offset === 0 || !RSA_SPKI_ALGORITHM_IDENTIFIER.every((byte, i) => spki[offset + i] === byte)) {
    errInvalidKey("RSA SPKI must carry the rsaEncryption AlgorithmIdentifier");
  }
}

/** The fixed 12-byte RFC 8410 SPKI prefix check (reference: webcrypto.js:3808). */
export function rfc8410SpkiKey(oidTail: number, spki: Uint8Array, what: string): Uint8Array {
  const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oidTail, 0x03, 0x21, 0x00];
  const ok = spki.length === 44 && prefix.every((byte, i) => spki[i] === byte);
  if (!ok) {
    errInvalidKey(`${what}: not an RFC 8410 SubjectPublicKeyInfo`);
  }
  return spki.slice(12);
}
