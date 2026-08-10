// `polymorph:webcrypto/signature` (the algorithm-agnostic sign/verify
// resources) plus `ed25519-verify` / `ed25519-sign` — wit/webcrypto.wit
// `interface signature`, wit/ed25519.wit.
//
// The resource classes here are shared by every signature family:
// `ed25519-*` (this module), `ecdsa-*` (ecdsa.ts) and the two RSA pairs
// (rsaSignature.ts) all mint the same `verifying-key`/`signing-key`. Each
// key carries the ALGORITHM RECORD bound at its mint — never
// `CryptoKey.algorithm` — as the authority for the per-operation hash, the
// PSS salt length, the signature width, and the getters' answers: an
// engine that names its algorithms differently must not be able to switch
// a mandatory check off (reference: js/jco/webcrypto.js:4087-4110).

import {
  errAuthenticationFailed,
  errInvalidKey,
  errNotExtractable,
  errUnsupported,
  grantedUsages,
  notPermitted,
  platformCall,
} from "./errors.ts";
import { asBufferSource, collectByteStream, unwrappedJwk } from "./util.ts";
import {
  importPlatformKey,
  importPlatformKeyJwk,
  jwkMaterial,
  redactingInvalidKey,
  requireStrictBase64url,
  rfc8410SpkiKey,
} from "./platform.ts";
import { b64urlDecode } from "./platform.ts";
import { consumeUnwrapInput, type UnwrapInput, WrapInput } from "./wrapping.ts";
import { errOther } from "./errors.ts";
import type { Stream } from "../../../runtime/src/embedder/mod.ts";

const subtle = globalThis.crypto.subtle;

/** The mint-bound algorithm record every signature key carries (reference: webcrypto.js:3970). */
export interface SignatureAlgorithm {
  /** The WebCrypto registry name (`"Ed25519"`, `"ECDSA"`, `"RSA-PSS"`, …). */
  name: string;
  /** The EC curve, for the getters; `undefined` off the EC families. */
  namedCurve: string | undefined;
  /** The mint-bound digest; `undefined` for Ed25519 (RFC 8032 fixes it internally). */
  hash: string | undefined;
  /** The RSA modulus length in bits; `undefined` elsewhere. */
  length?: number;
  /** The fixed signature width in bytes this key accepts. */
  signatureLength: number;
  /** RSA-PSS's mint-bound salt length in bytes. */
  saltLength?: number;
  /** The uncompressed public-key length, where the raw form is admitted. */
  publicLength?: number;
}

/** The Ed25519 record (reference: webcrypto.js:4042). */
export const ED25519_ALGORITHM: SignatureAlgorithm = Object.freeze({
  name: "Ed25519",
  namedCurve: undefined,
  hash: undefined,
  publicLength: 32,
  signatureLength: 64,
});

/**
 * The per-operation WebCrypto parameter for a key's mint binding
 * (reference: webcrypto.js:4068): ECDSA passes its mint-bound hash,
 * RSA-PSS its mint-bound salt length; every other family's binding rides
 * the `CryptoKey`.
 */
// deno-lint-ignore no-explicit-any
function signParams(algorithm: SignatureAlgorithm): any {
  if (algorithm.name === "ECDSA") return { name: "ECDSA", hash: algorithm.hash };
  if (algorithm.name === "RSA-PSS") return { name: "RSA-PSS", saltLength: algorithm.saltLength };
  return algorithm.name;
}

// --- Ed25519 strict-validation predicates (the `ed25519-verify` WIT
// criterion: `verify_strict` semantics). Engines implement plain RFC 8032,
// which leaves acceptance of non-canonical and small-order inputs open, so
// this host enforces the pinned rejections itself: pure byte compares on
// public data, strictly monotone (they only add rejections in front of the
// engine). Reference: js/jco/webcrypto.js:4400-4470.

function unhexFixed(hex: string): Uint8Array {
  const pairs = hex.match(/../g);
  if (pairs === null || pairs.length * 2 !== hex.length) {
    throw new Error("malformed hex literal in the Ed25519 constant table");
  }
  return Uint8Array.from(pairs, (byte) => parseInt(byte, 16));
}

/** The field prime p = 2^255 - 19, little-endian. */
const ED25519_P = unhexFixed(
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
);
/** The group order L, little-endian. */
const ED25519_L = unhexFixed(
  "edd3f55c1a631258d69cf7a2def9de14" + "00".repeat(15) + "10",
);
/** The y-coordinates of the 8-torsion subgroup (reference: webcrypto.js:4409). */
const ED25519_SMALL_ORDER_Y = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map(unhexFixed);

function ltLittleEndian(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Canonical (y < p) and not small-order — the predicate for `A` at import and `R` at verify. */
function ed25519PointStrict(encoded: Uint8Array): boolean {
  const y = encoded.slice();
  y[31] &= 0x7f; // mask the x sign bit
  if (!ltLittleEndian(y, ED25519_P)) return false;
  return !ED25519_SMALL_ORDER_Y.some((torsion) => bytesEqual(y, torsion));
}

/** `signature.verifying-key`: a public key, secret-free. */
export class VerifyingKey {
  #key: CryptoKey;
  #algorithm: SignatureAlgorithm;

  constructor(key: CryptoKey, algorithm: SignatureAlgorithm) {
    this.#key = key;
    this.#algorithm = algorithm;
  }
  get cryptoKey(): CryptoKey {
    return this.#key;
  }

  /**
   * Verify `sig` over the whole stream; a failure — including a malformed
   * signature, which WebCrypto reports as a plain `false` — is
   * `error.authentication-failed`. The stream is drained first (this host
   * drains to completion rather than closing early).
   */
  async verify(data: Stream<number>, sig: Uint8Array): Promise<void> {
    const message = await collectByteStream(data);
    // Each family's signature width is fixed at mint (Ed25519's 64-byte
    // `R ‖ S`; ECDSA's P1363 `r ‖ s`; RSA's modulus-length octet string).
    // Engines differ — Firefox zero-pads short halves — so the width is
    // enforced here: a pure length check on public data (reference:
    // webcrypto.js:4118-4128).
    if (sig.length !== this.#algorithm.signatureLength) errAuthenticationFailed();
    if (this.#algorithm.name === "Ed25519") {
      if (!ltLittleEndian(sig.subarray(32), ED25519_L)) errAuthenticationFailed();
      if (!ed25519PointStrict(sig.subarray(0, 32))) errAuthenticationFailed();
    }
    const ok = await platformCall(`${this.#algorithm.name} verify`, () =>
      subtle.verify(signParams(this.#algorithm), this.#key, asBufferSource(sig), asBufferSource(message)));
    if (!ok) errAuthenticationFailed();
  }

  algorithmName(): string {
    return this.#algorithm.name;
  }
  algorithmCurve(): string | undefined {
    return this.#algorithm.namedCurve;
  }
  algorithmHash(): string | undefined {
    return this.#algorithm.hash;
  }
  algorithmLength(): number | undefined {
    return this.#algorithm.length;
  }
  algorithmPublicExponent(): Uint8Array | undefined {
    const e = (this.#key.algorithm as RsaHashedKeyAlgorithm).publicExponent;
    return e === undefined ? undefined : new Uint8Array(e);
  }

  /** The RSA family has no raw public form: the WIT pins `unsupported` (reference: webcrypto.js:4180). */
  async exportKeyRaw(): Promise<Uint8Array> {
    if (this.#algorithm.name === "RSASSA-PKCS1-v1_5" || this.#algorithm.name === "RSA-PSS") {
      errUnsupported("RSA public keys have no raw form");
    }
    const raw = await platformCall("raw key export", () => subtle.exportKey("raw", this.#key));
    return new Uint8Array(raw);
  }
  async exportKeySpki(): Promise<Uint8Array> {
    const spki = await platformCall("spki key export", () => subtle.exportKey("spki", this.#key));
    return new Uint8Array(spki);
  }
  /** Material members only, per the package-wide JWK contract (reference: webcrypto.js:4210). */
  async exportKeyJwk(): Promise<string> {
    const jwk = await platformCall("jwk key export", () => subtle.exportKey("jwk", this.#key));
    if (jwk.kty === "OKP") return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
    if (jwk.kty === "RSA") return JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e });
    return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  }
}

/** `signature.signing-key`: a private key. */
export class SigningKey {
  #key: CryptoKey;
  #algorithm: SignatureAlgorithm;

  constructor(key: CryptoKey, algorithm: SignatureAlgorithm) {
    this.#key = key;
    this.#algorithm = algorithm;
  }

  async sign(data: Stream<number>): Promise<Uint8Array> {
    const message = await collectByteStream(data);
    if (!this.canSign()) notPermitted("sign");
    const sig = await platformCall(`${this.#algorithm.name} sign`, () =>
      subtle.sign(signParams(this.#algorithm), this.#key, asBufferSource(message)));
    return new Uint8Array(sig);
  }

  algorithmName(): string {
    return this.#algorithm.name;
  }
  algorithmCurve(): string | undefined {
    return this.#algorithm.namedCurve;
  }
  algorithmHash(): string | undefined {
    return this.#algorithm.hash;
  }
  algorithmLength(): number | undefined {
    return this.#algorithm.length;
  }
  algorithmPublicExponent(): Uint8Array | undefined {
    const e = (this.#key.algorithm as RsaHashedKeyAlgorithm).publicExponent;
    return e === undefined ? undefined : new Uint8Array(e);
  }
  extractable(): boolean {
    return this.#key.extractable;
  }
  canSign(): boolean {
    return this.#key.usages.includes("sign");
  }

  /** Material members only; full-CRT for RSA (reference: webcrypto.js:4310). */
  async exportKeyJwk(): Promise<string> {
    if (!this.#key.extractable) errNotExtractable();
    const jwk = await platformCall("jwk key export", () => subtle.exportKey("jwk", this.#key));
    if (jwk.kty === "RSA") {
      return JSON.stringify({
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        d: jwk.d,
        p: jwk.p,
        q: jwk.q,
        dp: jwk.dp,
        dq: jwk.dq,
        qi: jwk.qi,
      });
    }
    return JSON.stringify(
      jwk.kty === "OKP"
        ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }
        : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    );
  }
  async exportKeyPkcs8(): Promise<Uint8Array> {
    if (!this.#key.extractable) errNotExtractable();
    const pkcs8 = await platformCall("pkcs8 key export", () => subtle.exportKey("pkcs8", this.#key));
    return new Uint8Array(pkcs8);
  }
  async toWrapInputJwk(): Promise<WrapInput> {
    return new WrapInput("jwk", new TextEncoder().encode(await this.exportKeyJwk()));
  }
  async toWrapInputPkcs8(): Promise<WrapInput> {
    return new WrapInput("pkcs8", await this.exportKeyPkcs8());
  }
}

export interface SigningPolicy {
  sign: boolean;
  extractable: boolean;
}

const signOptionsState = new WeakMap<SigningKeyOptions, SigningPolicy>();

export function signingPolicyOf(o: SigningKeyOptions): SigningPolicy {
  const p = signOptionsState.get(o);
  if (p === undefined) errOther("signing-key-options minted by another provider");
  return p;
}

/** `signature.signing-key-options`. */
export class SigningKeyOptions {
  constructor() {
    signOptionsState.set(this, { sign: false, extractable: false });
  }
  canSign(allowed: boolean): void {
    signingPolicyOf(this).sign = allowed;
  }
  extractable(allowed: boolean): void {
    signingPolicyOf(this).extractable = allowed;
  }
}

/** `sign` is the sole usage, so it must be granted (reference: webcrypto.js:4251). */
export function requireSigningGrant(policy: SigningPolicy): void {
  grantedUsages([["sign", policy.sign]]);
}

/**
 * The `polymorph:webcrypto/signature@0.1.0` interface: its resource classes.
 *
 * `SigningKeyOptions` is DEFINED by `signature` (webcrypto.wit:604,613)
 * and merely `use`d by the `-sign` interfaces — a component importing both
 * needs the class published under the defining interface too (found by the
 * iroh endpoint exam).
 */
export const signature = { VerifyingKey, SigningKey, SigningKeyOptions };

/**
 * The Ed25519 JWK `alg` policy: the two registered spellings, matched
 * case-SENSITIVELY (RFC 8037 `EdDSA` and the CFRG registry's `Ed25519`).
 * Checked host-side because Deno's import accepts a wrong-case `alg`
 * where the WIT — and the suite's `probe/sig-public-format-imports` case
 * — require `error.invalid-key`.
 */
function requireEd25519JwkAlg(jwk: Record<string, unknown>): void {
  const alg = jwk.alg;
  if (alg === undefined) return;
  if (alg !== "Ed25519" && alg !== "EdDSA") {
    errInvalidKey(`Ed25519 JWK declares alg ${String(alg)}; the registered spellings are Ed25519 and EdDSA`);
  }
}

/** The `polymorph:webcrypto/ed25519-verify@0.1.0` interface. */
export const ed25519Verify = {
  importVerifyingKeyRaw: async (raw: Uint8Array): Promise<VerifyingKey> => {
    if (raw.length !== 32) errInvalidKey(`Ed25519 public keys are 32 bytes, got ${raw.length}`);
    if (!ed25519PointStrict(raw)) errInvalidKey("non-canonical or small-order Ed25519 public key");
    const key = await importPlatformKey("Ed25519 public key", "raw", raw, "Ed25519", true, ["verify"]);
    return new VerifyingKey(key, ED25519_ALGORITHM);
  },
  importVerifyingKeySpki: async (spki: Uint8Array): Promise<VerifyingKey> => {
    const point = rfc8410SpkiKey(0x70, spki, "Ed25519");
    if (!ed25519PointStrict(point)) errInvalidKey("non-canonical or small-order Ed25519 public key");
    const key = await importPlatformKey("Ed25519 spki", "spki", spki, "Ed25519", true, ["verify"]);
    return new VerifyingKey(key, ED25519_ALGORITHM);
  },
  importVerifyingKeyJwk: async (jwkText: string): Promise<VerifyingKey> => {
    const jwk = jwkMaterial(jwkText);
    requireEd25519JwkAlg(jwk);
    requireStrictBase64url(jwk.x);
    if (typeof jwk.x !== "string" || !ed25519PointStrict(b64urlDecode(jwk.x))) {
      errInvalidKey("non-canonical or small-order Ed25519 public key");
    }
    const key = await importPlatformKeyJwk("Ed25519 public JWK", jwk, "Ed25519", true, ["verify"]);
    return new VerifyingKey(key, ED25519_ALGORITHM);
  },
};

/** The `polymorph:webcrypto/ed25519-sign@0.1.0` interface. */
export const ed25519Sign = {
  SigningKeyOptions,
  generateKey: async (options: SigningKeyOptions): Promise<[SigningKey, VerifyingKey]> => {
    const policy = signingPolicyOf(options);
    requireSigningGrant(policy);
    // WebCrypto filters `usages` per key half from what was REQUESTED, so
    // both are asked for here: a platform detail, not a WIT grant
    // (`signing-key-options` carries no `can-verify` — `verifying-key` is
    // secret-free and always usable).
    const pair = await platformCall("Ed25519 key generation", () =>
      subtle.generateKey("Ed25519", policy.extractable, ["sign", "verify"])) as CryptoKeyPair;
    return [new SigningKey(pair.privateKey, ED25519_ALGORITHM), new VerifyingKey(pair.publicKey, ED25519_ALGORITHM)];
  },
  importSigningKeyPkcs8: async (pkcs8: Uint8Array, options: SigningKeyOptions): Promise<SigningKey> => {
    const policy = signingPolicyOf(options);
    requireSigningGrant(policy);
    const key = await importPlatformKey("Ed25519 pkcs8", "pkcs8", pkcs8, "Ed25519", policy.extractable, ["sign"]);
    return new SigningKey(key, ED25519_ALGORITHM);
  },
  importSigningKeyJwk: async (jwkText: string, options: SigningKeyOptions): Promise<SigningKey> => {
    const policy = signingPolicyOf(options);
    requireSigningGrant(policy);
    const jwk = jwkMaterial(jwkText);
    requireEd25519JwkAlg(jwk);
    requireStrictBase64url(jwk.x);
    requireStrictBase64url(jwk.d);
    const key = await importPlatformKeyJwk(
      "Ed25519 private JWK",
      jwk,
      "Ed25519",
      policy.extractable,
      ["sign"],
    );
    if (key.type !== "private") errInvalidKey("OKP private JWK must carry `d` (base64url private key)");
    return new SigningKey(key, ED25519_ALGORITHM);
  },
  unwrapSigningKeyPkcs8: (input: UnwrapInput, options: SigningKeyOptions): Promise<SigningKey> => {
    const { bytes } = consumeUnwrapInput(input);
    return redactingInvalidKey(
      "unwrapped Ed25519 pkcs8",
      () => ed25519Sign.importSigningKeyPkcs8(bytes, options),
    );
  },
  unwrapSigningKeyJwk: (input: UnwrapInput, options: SigningKeyOptions): Promise<SigningKey> => {
    const { bytes } = consumeUnwrapInput(input);
    requireSigningGrant(signingPolicyOf(options));
    const jwk = unwrappedJwk(bytes, "sig", ["sign"]);
    return redactingInvalidKey(
      "unwrapped Ed25519 private JWK",
      () => ed25519Sign.importSigningKeyJwk(jwk, options),
    );
  },
};
