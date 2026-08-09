// `polymorph:webcrypto/key-agreement` (algorithm-agnostic agreement
// resources) plus `x25519` (RFC 7748) — wit/agreement.wit, wit/x25519.wit.
//
// The iroh identity/exec-model path (mission context) exercises this family
// directly: tools/smoke-c0/leg2_exec_model.ts and
// wasi-shims/tests/integration_exec_model_test.ts's `webcryptoFixture()`
// both hand-roll exactly `key-agreement.{AgreementKeyOptions,PublicKey,
// SecretKey}` + `x25519.generateKey`; this module is the real port of that
// fixture, extended to the WIT's full import/unwrap/agree surface.

import { errInvalidKey, errNotExtractable, errOther, platformCall } from "./errors.ts";
import { asBufferSource } from "./util.ts";
import { mintDeriveInput, type DeriveInput, deriveUsages } from "./derivation.ts";
import { consumeUnwrapInput, type UnwrapInput, WrapInput } from "./wrapping.ts";
import { unwrappedJwk } from "./util.ts";

const subtle = globalThis.crypto.subtle;

interface AgreementPolicy {
  deriveBits: boolean;
  deriveKey: boolean;
  extractable: boolean;
}

const optionsState = new WeakMap<AgreementKeyOptions, AgreementPolicy>();

function optionsOf(o: AgreementKeyOptions): AgreementPolicy {
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
    optionsOf(this).deriveBits = allowed;
  }
  canDeriveKey(allowed: boolean): void {
    optionsOf(this).deriveKey = allowed;
  }
  extractable(allowed: boolean): void {
    optionsOf(this).extractable = allowed;
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
    return JSON.stringify(jwk);
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
  agree(peer: PublicKey): DeriveInput {
    const params = { name: "X25519", public: peer.cryptoKey } as unknown as Record<string, unknown>;
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
    return this.#key.extractable;
  }
  async exportKeyJwk(): Promise<string> {
    if (!this.#key.extractable) errNotExtractable();
    const jwk = await platformCall("export jwk", () => subtle.exportKey("jwk", this.#key));
    return JSON.stringify(jwk);
  }
  async exportKeyPkcs8(): Promise<Uint8Array> {
    if (!this.#key.extractable) errNotExtractable();
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

/** The `polymorph:webcrypto/x25519@0.1.0` interface. */
export const x25519 = {
  importPublicKeyRaw: async (raw: Uint8Array): Promise<PublicKey> => {
    if (raw.length !== 32) errInvalidKey("X25519 public key must be 32 bytes (RFC 7748 u-coordinate)");
    const key = await platformCall("X25519 import raw", () =>
      subtle.importKey("raw", asBufferSource(raw), "X25519", true, []));
    return new PublicKey(key as CryptoKey);
  },
  importPublicKeySpki: async (spki: Uint8Array): Promise<PublicKey> => {
    const key = await platformCall("X25519 import spki", () =>
      subtle.importKey("spki", asBufferSource(spki), "X25519", true, []));
    return new PublicKey(key as CryptoKey);
  },
  importPublicKeyJwk: async (jwk: string): Promise<PublicKey> => {
    const key = await platformCall("X25519 import jwk", () =>
      subtle.importKey("jwk", JSON.parse(jwk), "X25519", true, []));
    return new PublicKey(key as CryptoKey);
  },
  importSecretKeyJwk: async (jwk: string, options: AgreementKeyOptions): Promise<SecretKey> => {
    const policy = optionsOf(options);
    const key = await platformCall("X25519 import secret jwk", () =>
      subtle.importKey("jwk", JSON.parse(jwk), "X25519", policy.extractable, deriveUsages(policy)));
    return new SecretKey(key as CryptoKey, policy);
  },
  importSecretKeyPkcs8: async (pkcs8: Uint8Array, options: AgreementKeyOptions): Promise<SecretKey> => {
    const policy = optionsOf(options);
    const key = await platformCall("X25519 import secret pkcs8", () =>
      subtle.importKey("pkcs8", asBufferSource(pkcs8), "X25519", policy.extractable, deriveUsages(policy)));
    return new SecretKey(key as CryptoKey, policy);
  },
  generateKey: async (options: AgreementKeyOptions): Promise<[SecretKey, PublicKey]> => {
    const policy = optionsOf(options);
    const pair = await platformCall("X25519 generate key", () =>
      subtle.generateKey({ name: "X25519" }, policy.extractable, deriveUsages(policy))) as CryptoKeyPair;
    return [new SecretKey(pair.privateKey, policy), new PublicKey(pair.publicKey)];
  },
  unwrapSecretKeyJwk: async (input: UnwrapInput, options: AgreementKeyOptions): Promise<SecretKey> => {
    const { bytes } = consumeUnwrapInput(input);
    const policy = optionsOf(options);
    const jwk = unwrappedJwk(bytes, "enc", deriveUsages(policy));
    return x25519.importSecretKeyJwk(jwk, options);
  },
  unwrapSecretKeyPkcs8: async (input: UnwrapInput, options: AgreementKeyOptions): Promise<SecretKey> => {
    const { bytes } = consumeUnwrapInput(input);
    return x25519.importSecretKeyPkcs8(bytes, options);
  },
};
