// `polymorph:webcrypto/cipher` (the algorithm-agnostic unauthenticated
// cipher resources) plus `aes-cbc` / `aes-ctr` — wit/encryption.wit
// `interface cipher`, wit/aes.wit.
//
// Behavioral reference: js/jco/webcrypto.js:2667-3091 (`CipherKeyOptions`,
// `cipherParams`, `CipherKey`, `cipherMinting`). Nothing here authenticates:
// the WIT's Security notes make every malformed-input failure ONE uniform
// `error.other`, because a distinguishable padding verdict is a
// padding-oracle amplifier.

import {
  errInvalidKey,
  errInvalidNonce,
  errNotPermitted,
  errOther,
  notPermitted,
  platformCall,
} from "./errors.ts";
import { asBufferSource, collectByteStream, unwrappedJwk } from "./util.ts";
import {
  aesVariantByteLength,
  exportJwkGated,
  exportRawGated,
  importPlatformKey,
  importPlatformKeyJwk,
  jwkKeyBytes,
  jwkMaterial,
  redactingInvalidKey,
  requireStrictBase64url,
} from "./platform.ts";
import { type DeriveInput, deriveKeyFrom } from "./derivation.ts";
import { consumeUnwrapInput, consumeWrapInput, UnwrapInput, WrapInput } from "./wrapping.ts";
import type { Stream } from "../../../runtime/src/embedder/mod.ts";

const subtle = globalThis.crypto.subtle;

export type CipherName = "AES-CBC" | "AES-CTR";

interface CipherPolicy {
  encrypt: boolean;
  decrypt: boolean;
  wrap: boolean;
  unwrap: boolean;
  extractable: boolean;
}

const cipherPolicies = new WeakMap<CipherKeyOptions, CipherPolicy>();

function cipherPolicyOf(o: CipherKeyOptions): CipherPolicy {
  const p = cipherPolicies.get(o);
  if (p === undefined) errOther("cipher-key-options minted by another provider");
  return p;
}

/** `cipher.cipher-key-options` (reference: webcrypto.js:2672). */
export class CipherKeyOptions {
  constructor() {
    cipherPolicies.set(this, {
      encrypt: false,
      decrypt: false,
      wrap: false,
      unwrap: false,
      extractable: false,
    });
  }
  canEncrypt(allowed: boolean): void {
    cipherPolicyOf(this).encrypt = allowed;
  }
  canDecrypt(allowed: boolean): void {
    cipherPolicyOf(this).decrypt = allowed;
  }
  canWrap(allowed: boolean): void {
    cipherPolicyOf(this).wrap = allowed;
  }
  canUnwrap(allowed: boolean): void {
    cipherPolicyOf(this).unwrap = allowed;
  }
  extractable(allowed: boolean): void {
    cipherPolicyOf(this).extractable = allowed;
  }
}

/**
 * The platform usages a cipher mint needs (reference: webcrypto.js:2719):
 * `wrap` runs `subtle.encrypt` and `unwrap` runs `subtle.decrypt`, so the
 * WIT grants do not map one-to-one and are enforced host-side instead.
 */
function cipherUsages(policy: CipherPolicy): KeyUsage[] {
  const usages: KeyUsage[] = [];
  if (policy.encrypt || policy.wrap) usages.push("encrypt");
  if (policy.decrypt || policy.unwrap) usages.push("decrypt");
  if (usages.length === 0) errNotPermitted("a key with no enabled usage cannot be minted");
  return usages;
}

/** The granted operations' platform names, for the unwrap-path `key_ops` rule (reference: webcrypto.js:2749). */
function cipherGrantedOps(policy: CipherPolicy): string[] {
  const ops: string[] = [];
  if (policy.encrypt) ops.push("encrypt");
  if (policy.decrypt) ops.push("decrypt");
  if (policy.wrap) ops.push("wrapKey");
  if (policy.unwrap) ops.push("unwrapKey");
  return ops;
}

/**
 * Validate a per-call IV/counter-length pair against the key's mode and
 * build the platform params (reference: webcrypto.js:2767). AES-CBC
 * rejects a supplied counter length and AES-CTR rejects its absence —
 * both `error.invalid-nonce`, as the WIT pins.
 */
function cipherParams(name: CipherName, iv: Uint8Array, counterLength: number | undefined): AesCbcParams | AesCtrParams {
  if (name === "AES-CBC" && counterLength !== undefined) {
    errInvalidNonce("AES-CBC takes no counter length");
  }
  if (name === "AES-CTR") {
    if (counterLength === undefined) {
      errInvalidNonce("AES-CTR requires a counter length");
    }
    if (counterLength === 0 || counterLength > 128) {
      errInvalidNonce(`the counter length must be 1 to 128 bits, got ${counterLength}`);
    }
  }
  if (iv.length !== 16) {
    errInvalidNonce(`${name} requires a 16-byte IV, got ${iv.length} bytes`);
  }
  return name === "AES-CBC"
    ? { name, iv: asBufferSource(iv) }
    : { name, counter: asBufferSource(iv), length: counterLength as number };
}

/**
 * `cipher.cipher-key` (reference: webcrypto.js:2805). `encrypt`/`decrypt`
 * return the ciphertext/plaintext as a `stream<u8>`: this port lowers a
 * one-chunk producer (contracts/embedder-api.md §"Streams and futures" —
 * the lowering layer accepts an iterable of chunks and owns the pumping).
 */
export class CipherKey {
  #key: CryptoKey;
  #name: CipherName;
  #lengthBits: number;
  #grants: CipherPolicy;

  constructor(key: CryptoKey, name: CipherName, lengthBits: number, grants: CipherPolicy) {
    this.#key = key;
    this.#name = name;
    this.#lengthBits = lengthBits;
    this.#grants = { ...grants };
  }

  async #encrypt(iv: Uint8Array, counterLength: number | undefined, message: Uint8Array): Promise<Uint8Array> {
    const params = cipherParams(this.#name, iv, counterLength);
    const sealed = await platformCall(`${this.#name} encrypt`, () =>
      subtle.encrypt(params, this.#key, asBufferSource(message)));
    return new Uint8Array(sealed);
  }

  /**
   * Decrypt, collapsing EVERY platform failure to one uniform
   * `error.other` (reference: webcrypto.js:2871): the WIT closes off the
   * padding verdict deliberately.
   */
  async #decrypt(iv: Uint8Array, counterLength: number | undefined, message: Uint8Array): Promise<Uint8Array> {
    const params = cipherParams(this.#name, iv, counterLength);
    try {
      return new Uint8Array(await subtle.decrypt(params, this.#key, asBufferSource(message)));
    } catch {
      errOther(`${this.#name} decryption failed`);
    }
  }

  async encrypt(
    iv: Uint8Array,
    counterLength: number | undefined,
    plaintext: Stream<number>,
  ): Promise<Uint8Array[]> {
    const message = await collectByteStream(plaintext);
    if (!this.canEncrypt()) notPermitted("encrypt");
    return [await this.#encrypt(iv, counterLength, message)];
  }

  async decrypt(
    iv: Uint8Array,
    counterLength: number | undefined,
    ciphertext: Stream<number>,
  ): Promise<Uint8Array[]> {
    const message = await collectByteStream(ciphertext);
    if (!this.canDecrypt()) notPermitted("decrypt");
    return [await this.#decrypt(iv, counterLength, message)];
  }

  async wrap(iv: Uint8Array, counterLength: number | undefined, input: WrapInput): Promise<Uint8Array> {
    const { bytes } = consumeWrapInput(input);
    if (!this.canWrap()) notPermitted("wrap");
    return this.#encrypt(iv, counterLength, bytes);
  }

  async unwrap(iv: Uint8Array, counterLength: number | undefined, wrapped: Uint8Array): Promise<UnwrapInput> {
    if (!this.canUnwrap()) notPermitted("unwrap");
    return new UnwrapInput(await this.#decrypt(iv, counterLength, wrapped));
  }

  algorithmName(): string {
    return this.#name;
  }
  algorithmLength(): number {
    return this.#lengthBits;
  }
  ivSize(): number {
    return 16;
  }
  extractable(): boolean {
    return this.#key.extractable;
  }
  canEncrypt(): boolean {
    return this.#grants.encrypt;
  }
  canDecrypt(): boolean {
    return this.#grants.decrypt;
  }
  canWrap(): boolean {
    return this.#grants.wrap;
  }
  canUnwrap(): boolean {
    return this.#grants.unwrap;
  }

  exportKeyRaw(): Promise<Uint8Array> {
    return exportRawGated(this.#key);
  }
  exportKeyJwk(): Promise<string> {
    return exportJwkGated(this.#key);
  }
  async toWrapInputRaw(): Promise<WrapInput> {
    return new WrapInput("raw", await exportRawGated(this.#key));
  }
  async toWrapInputJwk(): Promise<WrapInput> {
    return new WrapInput("jwk", new TextEncoder().encode(await exportJwkGated(this.#key)));
  }
}

/** The `aes-cbc` / `aes-ctr` minting pair over one mode name (reference: webcrypto.js:2963). */
function cipherMinting(name: CipherName) {
  const minting = {
    async importKeyRaw(variant: string, raw: Uint8Array, options: CipherKeyOptions): Promise<CipherKey> {
      const policy = cipherPolicyOf(options);
      const usages = cipherUsages(policy);
      const expected = aesVariantByteLength(variant);
      if (raw.length !== expected) {
        errInvalidKey(`${variant} requires ${expected} key bytes, got ${raw.length}`);
      }
      const key = await importPlatformKey(`${variant} key`, "raw", raw, { name }, policy.extractable, usages);
      return new CipherKey(key, name, expected * 8, policy);
    },

    async importKeyJwk(variant: string, jwk: string, options: CipherKeyOptions): Promise<CipherKey> {
      const policy = cipherPolicyOf(options);
      const usages = cipherUsages(policy);
      const lengthBits = aesVariantByteLength(variant) * 8;
      const material = jwkMaterial(jwk);
      requireStrictBase64url(material.k);
      const key = await importPlatformKeyJwk(`${variant} JWK`, material, { name }, policy.extractable, usages);
      const gotBits = jwkKeyBytes(material.k) * 8;
      if (gotBits !== lengthBits) {
        errInvalidKey(`JWK carries a ${gotBits}-bit key; ${variant} requires ${lengthBits}`);
      }
      return new CipherKey(key, name, lengthBits, policy);
    },

    async generateKey(variant: string, options: CipherKeyOptions): Promise<CipherKey> {
      const policy = cipherPolicyOf(options);
      const usages = cipherUsages(policy);
      const bits = aesVariantByteLength(variant) * 8;
      const key = await platformCall(`${variant} key generation`, () =>
        subtle.generateKey({ name, length: bits }, policy.extractable, usages)) as CryptoKey;
      return new CipherKey(key, name, bits, policy);
    },

    async deriveKey(variant: string, input: DeriveInput, options: CipherKeyOptions): Promise<CipherKey> {
      const policy = cipherPolicyOf(options);
      const usages = cipherUsages(policy);
      const bits = aesVariantByteLength(variant) * 8;
      const key = await deriveKeyFrom(input, { name, length: bits }, policy.extractable, usages);
      return new CipherKey(key, name, bits, policy);
    },

    unwrapKeyRaw(variant: string, input: UnwrapInput, options: CipherKeyOptions): Promise<CipherKey> {
      const { bytes } = consumeUnwrapInput(input);
      return redactingInvalidKey(
        `unwrapped ${variant} key material`,
        () => minting.importKeyRaw(variant, bytes, options),
      );
    },

    unwrapKeyJwk(variant: string, input: UnwrapInput, options: CipherKeyOptions): Promise<CipherKey> {
      const { bytes } = consumeUnwrapInput(input);
      const policy = cipherPolicyOf(options);
      cipherUsages(policy);
      const jwk = unwrappedJwk(bytes, "enc", cipherGrantedOps(policy));
      return redactingInvalidKey(
        `unwrapped ${variant} JWK`,
        () => minting.importKeyJwk(variant, jwk, options),
      );
    },
  };
  return minting;
}

/** The `polymorph:webcrypto/cipher@0.1.0` interface: its resource classes. */
export const cipher = { CipherKey, CipherKeyOptions };

/** The `polymorph:webcrypto/aes-cbc@0.1.0` interface. */
export const aesCbc = cipherMinting("AES-CBC");

/** The `polymorph:webcrypto/aes-ctr@0.1.0` interface. */
export const aesCtr = cipherMinting("AES-CTR");
