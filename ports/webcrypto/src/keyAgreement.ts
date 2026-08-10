// `polymorph:webcrypto/key-agreement` (algorithm-agnostic agreement
// resources) plus `x25519` (RFC 7748) — wit/agreement.wit, wit/x25519.wit.
//
// The iroh identity/exec-model path (mission context) exercises this family
// directly: tools/smoke-c0/leg2_exec_model.ts and
// wasi-shims/tests/integration_exec_model_test.ts's `webcryptoFixture()`
// both hand-roll exactly `key-agreement.{AgreementKeyOptions,PublicKey,
// SecretKey}` + `x25519.generateKey`; this module is the real port of that
// fixture, extended to the WIT's full import/unwrap/agree surface.

import { asPlatformFailure, errInvalidKey, errNotExtractable, errNotPermitted, errOther, platformCall } from "./errors.ts";
import { importPlatformKey, importPlatformKeyJwk, jwkMaterial, redactingInvalidKey, requireStrictBase64url } from "./platform.ts";
import { type DeriveInput, mintDeriveInput } from "./derivation.ts";
import { consumeUnwrapInput, type UnwrapInput, WrapInput } from "./wrapping.ts";
import { unwrappedJwk } from "./util.ts";

const subtle = globalThis.crypto.subtle;

export interface AgreementPolicy {
  deriveBits: boolean;
  deriveKey: boolean;
  extractable: boolean;
}

const optionsState = new WeakMap<AgreementKeyOptions, AgreementPolicy>();

export function agreementPolicyOf(o: AgreementKeyOptions): AgreementPolicy {
  const p = optionsState.get(o);
  if (p === undefined) errOther("agreement-key-options minted by another provider");
  return p;
}

/** `key-agreement.agreement-key-options`. */
export class AgreementKeyOptions {
  constructor() {
    optionsState.set(this, { deriveBits: false, deriveKey: false, extractable: false });
  }
  canDeriveBits(allowed: boolean): void {
    agreementPolicyOf(this).deriveBits = allowed;
  }
  canDeriveKey(allowed: boolean): void {
    agreementPolicyOf(this).deriveKey = allowed;
  }
  extractable(allowed: boolean): void {
    agreementPolicyOf(this).extractable = allowed;
  }
}

/** `key-agreement.public-key`: exchangeable, secret-free. */
export class PublicKey {
  #key: CryptoKey;
  constructor(key: CryptoKey) {
    this.#key = key;
  }
  get cryptoKey(): CryptoKey {
    return this.#key;
  }
  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  async exportKeyRaw(): Promise<Uint8Array> {
    const raw = await platformCall("export raw", () => subtle.exportKey("raw", this.#key));
    return new Uint8Array(raw);
  }
  async exportKeyJwk(): Promise<string> {
    const jwk = await platformCall("export jwk", () => subtle.exportKey("jwk", this.#key));
    // Material members only, per the package-wide JWK contract (reference:
    // js/jco/webcrypto.js:1729-1741): OKP for X25519, EC for ECDH.
    return JSON.stringify(
      jwk.kty === "OKP"
        ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
        : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    );
  }
  async exportKeySpki(): Promise<Uint8Array> {
    const spki = await platformCall("export spki", () => subtle.exportKey("spki", this.#key));
    return new Uint8Array(spki);
  }
}

/** `key-agreement.secret-key`. */
export class SecretKey {
  #key: CryptoKey;
  #policy: AgreementPolicy;
  constructor(key: CryptoKey, policy: AgreementPolicy) {
    this.#key = key;
    this.#policy = { ...policy };
  }

  /**
   * The shared secret with `peer` as a `derive-input` with a *natural*
   * output length (the whole agreed secret — 32 bytes for X25519), per
   * wit/agreement.wit `secret-key.agree`. The params bound here
   * (`{name:"X25519", public: peer}`) drive `derivation.ts`'s shared
   * `deriveBits`/`deriveKeyFrom` machinery directly against this secret
   * key — no intermediate re-import, matching WebCrypto's own
   * `deriveBits`/`deriveKey` over an ECDH-family algorithm.
   *
   * `error.invalid-key` on the platform's mandatory contributory
   * (all-zero shared-secret) check surfaces from `derive-input.derive-bits`
   * itself (WebCrypto rejects a small-order peer there), not here.
   */
  async agree(peer: PublicKey): Promise<DeriveInput> {
    const params = { name: this.#key.algorithm.name, public: peer.cryptoKey } as unknown as Record<string, unknown>;
    // The WIT pins the contributory (all-zero shared secret) check HERE,
    // so the platform derivation runs once now as a probe and its output
    // is discarded (reference: js/jco/webcrypto.js:1795-1815). An
    // algorithm-mismatched peer surfaces from the same probe.
    try {
      await subtle.deriveBits(params as unknown as AlgorithmIdentifier, this.#key, null as unknown as number);
    } catch (err) {
      const failure = asPlatformFailure(err);
      if (failure.name === "OperationError") {
        errInvalidKey("the shared secret is all-zero: the peer public key is a small-order point");
      }
      if (failure.name === "InvalidAccessError") {
        errInvalidKey(`peer key is not usable with this key: ${failure.detail}`);
      }
      errOther(`agreement failed: ${failure.detail}`);
    }
    return mintDeriveInput(this.#key, params, this.#policy, /* hasNaturalLength */ true);
  }

  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  canDeriveBits(): boolean {
    return this.#policy.deriveBits;
  }
  canDeriveKey(): boolean {
    return this.#policy.deriveKey;
  }
  extractable(): boolean {
    return this.#policy.extractable;
  }
  async exportKeyJwk(): Promise<string> {
    if (!this.#policy.extractable) errNotExtractable();
    const jwk = await platformCall("export jwk", () => subtle.exportKey("jwk", this.#key));
    // Material members only (reference: js/jco/webcrypto.js:1835-1846).
    return JSON.stringify(
      jwk.kty === "OKP"
        ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }
        : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    );
  }
  async exportKeyPkcs8(): Promise<Uint8Array> {
    if (!this.#policy.extractable) errNotExtractable();
    const pkcs8 = await platformCall("export pkcs8", () => subtle.exportKey("pkcs8", this.#key));
    return new Uint8Array(pkcs8);
  }
  async toWrapInputJwk(): Promise<WrapInput> {
    const jwk = await this.exportKeyJwk();
    return new WrapInput("jwk", new TextEncoder().encode(jwk));
  }
  async toWrapInputPkcs8(): Promise<WrapInput> {
    return new WrapInput("pkcs8", await this.exportKeyPkcs8());
  }
}

/** The `polymorph:webcrypto/key-agreement@0.1.0` interface: its resource classes. */
export const keyAgreement = { AgreementKeyOptions, PublicKey, SecretKey };

/**
 * The usages every platform agreement secret key is minted with
 * (reference: js/jco/webcrypto.js:1765-1770): unlike the KDF base secrets,
 * the WIT grants do NOT ride the platform usages — `agree`'s contributory
 * probe is a platform `deriveBits` call and chaining is a `deriveKey`
 * call, and either must work whichever single grant the mint carried. The
 * grants are enforced host-side by `derive-input` instead.
 */
export const AGREEMENT_PLATFORM_USAGES: KeyUsage[] = ["deriveBits", "deriveKey"];

/** At least one derive grant, without projecting onto platform usages (reference: webcrypto.js:1888). */
export function requireAgreementGrant(policy: AgreementPolicy): void {
  if (!policy.deriveBits && !policy.deriveKey) {
    errNotPermitted("a key with no enabled usage cannot be minted");
  }
}

/** The granted operations' platform names, for the unwrap-path `key_ops` rule (reference: webcrypto.js:2008). */
export function agreementGrantedOps(policy: AgreementPolicy): string[] {
  const ops: string[] = [];
  if (policy.deriveBits) ops.push("deriveBits");
  if (policy.deriveKey) ops.push("deriveKey");
  return ops;
}

/** The `polymorph:webcrypto/x25519@0.1.0` interface. */
export const x25519 = {
  importPublicKeyRaw: async (raw: Uint8Array): Promise<PublicKey> => {
    if (raw.length !== 32) errInvalidKey("X25519 public key must be 32 bytes (RFC 7748 u-coordinate)");
    const key = await importPlatformKey("X25519 public key", "raw", raw, "X25519", true, []);
    return new PublicKey(key);
  },
  importPublicKeySpki: async (spki: Uint8Array): Promise<PublicKey> => {
    const key = await importPlatformKey("X25519 spki", "spki", spki, "X25519", true, []);
    return new PublicKey(key);
  },
  importPublicKeyJwk: async (jwkText: string): Promise<PublicKey> => {
    const jwk = jwkMaterial(jwkText);
    requireStrictBase64url(jwk.x);
    const key = await importPlatformKeyJwk("X25519 public JWK", jwk, "X25519", true, []);
    return new PublicKey(key);
  },
  importSecretKeyJwk: async (jwkText: string, options: AgreementKeyOptions): Promise<SecretKey> => {
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const jwk = jwkMaterial(jwkText);
    requireStrictBase64url(jwk.x);
    requireStrictBase64url(jwk.d);
    const key = await importPlatformKeyJwk(
      "X25519 private JWK",
      jwk,
      "X25519",
      policy.extractable,
      AGREEMENT_PLATFORM_USAGES,
    );
    if (key.type !== "private") {
      errInvalidKey("OKP private JWK must carry `d` (base64url private key)");
    }
    return new SecretKey(key, policy);
  },
  importSecretKeyPkcs8: async (pkcs8: Uint8Array, options: AgreementKeyOptions): Promise<SecretKey> => {
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const key = await importPlatformKey(
      "X25519 pkcs8",
      "pkcs8",
      pkcs8,
      "X25519",
      policy.extractable,
      AGREEMENT_PLATFORM_USAGES,
    );
    return new SecretKey(key, policy);
  },
  generateKey: async (options: AgreementKeyOptions): Promise<[SecretKey, PublicKey]> => {
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const pair = await platformCall("X25519 key generation", () =>
      subtle.generateKey("X25519", policy.extractable, AGREEMENT_PLATFORM_USAGES)) as CryptoKeyPair;
    return [new SecretKey(pair.privateKey, policy), new PublicKey(pair.publicKey)];
  },
  unwrapSecretKeyJwk: (input: UnwrapInput, options: AgreementKeyOptions): Promise<SecretKey> => {
    const { bytes } = consumeUnwrapInput(input);
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const jwk = unwrappedJwk(bytes, "enc", agreementGrantedOps(policy));
    return redactingInvalidKey("unwrapped X25519 private JWK", () => x25519.importSecretKeyJwk(jwk, options));
  },
  unwrapSecretKeyPkcs8: (input: UnwrapInput, options: AgreementKeyOptions): Promise<SecretKey> => {
    const { bytes } = consumeUnwrapInput(input);
    return redactingInvalidKey(
      "unwrapped X25519 pkcs8",
      () => x25519.importSecretKeyPkcs8(bytes, options),
    );
  },
};
