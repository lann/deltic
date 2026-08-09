// `polymorph:webcrypto/signature` (algorithm-agnostic sign/verify resources)
// plus `ed25519-verify` / `ed25519-sign` — wit/webcrypto.wit
// `interface signature`, wit/ed25519.wit.
//
// Ed25519 has no curve/hash parameters (RFC 8032 fixes SHA-512 internally),
// matching the reference's `SignatureAlgorithm` shape (js/jco/webcrypto.js:67-89).

import { errAuthenticationFailed, errInvalidKey, errNotExtractable, errNotPermitted, errOther, notPermitted, platformCall } from "./errors.ts";
import { asBufferSource, collectByteStream, unwrappedJwk } from "./util.ts";
import { consumeUnwrapInput, type UnwrapInput, WrapInput } from "./wrapping.ts";
import type { Stream } from "../../../runtime/src/embedder/mod.ts";

const subtle = globalThis.crypto.subtle;

/** `signature.verifying-key`: a public key, secret-free. */
export class VerifyingKey {
  #key: CryptoKey;
  constructor(key: CryptoKey) {
    this.#key = key;
  }
  get cryptoKey(): CryptoKey {
    return this.#key;
  }

  async verify(data: Stream<number>, sig: Uint8Array): Promise<void> {
    const message = await collectByteStream(data);
    const ok = await platformCall("Ed25519 verify", () =>
      subtle.verify("Ed25519", this.#key, asBufferSource(sig), asBufferSource(message)));
    if (!ok) errAuthenticationFailed();
  }

  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  algorithmCurve(): string | undefined {
    return undefined;
  }
  algorithmHash(): string | undefined {
    return undefined;
  }
  algorithmLength(): number | undefined {
    return undefined;
  }
  algorithmPublicExponent(): Uint8Array | undefined {
    return undefined;
  }

  async exportKeyRaw(): Promise<Uint8Array> {
    const raw = await platformCall("export raw", () => subtle.exportKey("raw", this.#key));
    return new Uint8Array(raw);
  }
  async exportKeySpki(): Promise<Uint8Array> {
    const spki = await platformCall("export spki", () => subtle.exportKey("spki", this.#key));
    return new Uint8Array(spki);
  }
  async exportKeyJwk(): Promise<string> {
    const jwk = await platformCall("export jwk", () => subtle.exportKey("jwk", this.#key));
    return JSON.stringify(jwk);
  }
}

/** `signature.signing-key`: a private key, one-shot `sign`. */
export class SigningKey {
  #key: CryptoKey;
  constructor(key: CryptoKey) {
    this.#key = key;
  }

  async sign(data: Stream<number>): Promise<Uint8Array> {
    const message = await collectByteStream(data);
    if (!this.canSign()) notPermitted("sign");
    const sig = await platformCall("Ed25519 sign", () => subtle.sign("Ed25519", this.#key, asBufferSource(message)));
    return new Uint8Array(sig);
  }

  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  algorithmCurve(): string | undefined {
    return undefined;
  }
  algorithmHash(): string | undefined {
    return undefined;
  }
  algorithmLength(): number | undefined {
    return undefined;
  }
  algorithmPublicExponent(): Uint8Array | undefined {
    return undefined;
  }
  extractable(): boolean {
    return this.#key.extractable;
  }
  canSign(): boolean {
    return this.#key.usages.includes("sign");
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

/** The `polymorph:webcrypto/signature@0.1.0` interface: its resource classes. */
export const signature = { VerifyingKey, SigningKey };

interface SigningKeyPolicy {
  sign: boolean;
  extractable: boolean;
}
const signOptionsState = new WeakMap<SigningKeyOptions, SigningKeyPolicy>();

function signOptionsOf(o: SigningKeyOptions): SigningKeyPolicy {
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
    signOptionsOf(this).sign = allowed;
  }
  extractable(allowed: boolean): void {
    signOptionsOf(this).extractable = allowed;
  }
}

function signUsages(policy: SigningKeyPolicy): KeyUsage[] {
  if (!policy.sign) errNotPermitted("a key with no enabled usage cannot be minted");
  return ["sign"];
}

/** The `polymorph:webcrypto/ed25519-verify@0.1.0` interface. */
export const ed25519Verify = {
  importVerifyingKeyRaw: async (raw: Uint8Array): Promise<VerifyingKey> => {
    if (raw.length !== 32) errInvalidKey("Ed25519 public key must be 32 bytes (RFC 8032 encoding)");
    const key = await platformCall("Ed25519 import raw", () =>
      subtle.importKey("raw", asBufferSource(raw), "Ed25519", true, ["verify"]));
    return new VerifyingKey(key as CryptoKey);
  },
  importVerifyingKeySpki: async (spki: Uint8Array): Promise<VerifyingKey> => {
    const key = await platformCall("Ed25519 import spki", () =>
      subtle.importKey("spki", asBufferSource(spki), "Ed25519", true, ["verify"]));
    return new VerifyingKey(key as CryptoKey);
  },
  importVerifyingKeyJwk: async (jwk: string): Promise<VerifyingKey> => {
    const key = await platformCall("Ed25519 import jwk", () =>
      subtle.importKey("jwk", JSON.parse(jwk), "Ed25519", true, ["verify"]));
    return new VerifyingKey(key as CryptoKey);
  },
};

/** The `polymorph:webcrypto/ed25519-sign@0.1.0` interface. */
export const ed25519Sign = {
  SigningKeyOptions,
  generateKey: async (options: SigningKeyOptions): Promise<[SigningKey, VerifyingKey]> => {
    const policy = signOptionsOf(options);
    signUsages(policy); // validates `can-sign` was granted (mint fails not-permitted otherwise)
    // WebCrypto's `generateKey` filters `usages` per key half (privateKey
    // gets "sign", publicKey gets "verify") only from what was REQUESTED —
    // it does not infer "verify" from a sign-only request, unlike this
    // interface's own model where the public half is unconditionally
    // usable. Requesting both here is a platform-usage detail, not a WIT
    // grant: `signing-key-options` carries no `can-verify` (there is
    // deliberately no such policy — `verifying-key` is secret-free and
    // always exportable per its own contract).
    const pair = await platformCall("Ed25519 generate key", () =>
      subtle.generateKey("Ed25519", policy.extractable, ["sign", "verify"])) as CryptoKeyPair;
    return [new SigningKey(pair.privateKey), new VerifyingKey(pair.publicKey)];
  },
  importSigningKeyPkcs8: async (pkcs8: Uint8Array, options: SigningKeyOptions): Promise<SigningKey> => {
    const policy = signOptionsOf(options);
    const usages = signUsages(policy);
    const key = await platformCall("Ed25519 import pkcs8", () =>
      subtle.importKey("pkcs8", asBufferSource(pkcs8), "Ed25519", policy.extractable, usages));
    return new SigningKey(key as CryptoKey);
  },
  importSigningKeyJwk: async (jwk: string, options: SigningKeyOptions): Promise<SigningKey> => {
    const policy = signOptionsOf(options);
    const usages = signUsages(policy);
    const key = await platformCall("Ed25519 import jwk", () =>
      subtle.importKey("jwk", JSON.parse(jwk), "Ed25519", policy.extractable, usages));
    return new SigningKey(key as CryptoKey);
  },
  unwrapSigningKeyPkcs8: async (input: UnwrapInput, options: SigningKeyOptions): Promise<SigningKey> => {
    const { bytes } = consumeUnwrapInput(input);
    return ed25519Sign.importSigningKeyPkcs8(bytes, options);
  },
  unwrapSigningKeyJwk: async (input: UnwrapInput, options: SigningKeyOptions): Promise<SigningKey> => {
    const { bytes } = consumeUnwrapInput(input);
    const jwk = unwrappedJwk(bytes, "sig", signOptionsOf(options).sign ? ["sign"] : []);
    return ed25519Sign.importSigningKeyJwk(jwk, options);
  },
};
