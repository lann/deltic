// `polymorph:webcrypto/key-wrap` plus `aes-kw` — wit/wrapping.wit
// `interface key-wrap`, wit/aes.wit `interface aes-kw`.
//
// Behavioral reference: js/jco/webcrypto.js:3097-3440. The platform's
// AES-KW operations wrap and unwrap `CryptoKey`s, not bytes, so both
// directions route the serialized material through a throwaway
// HMAC-SHA-256 `CryptoKey` whose raw import/export accepts any non-empty
// length; the wire format is RFC 3394's either way.

import { errAuthenticationFailed, errInvalidKey, errOther, decryptFailure, notPermitted, platformCall } from "./errors.ts";
import { asBufferSource, unwrappedJwk } from "./util.ts";
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
import { grantedUsages } from "./errors.ts";

const subtle = globalThis.crypto.subtle;

interface KwPolicy {
  wrap: boolean;
  unwrap: boolean;
  extractable: boolean;
}

const kwPolicies = new WeakMap<KwKeyOptions, KwPolicy>();

function kwPolicyOf(o: KwKeyOptions): KwPolicy {
  const p = kwPolicies.get(o);
  if (p === undefined) errOther("kw-key-options minted by another provider");
  return p;
}

/** `key-wrap.kw-key-options` (reference: webcrypto.js:3098). */
export class KwKeyOptions {
  constructor() {
    kwPolicies.set(this, { wrap: false, unwrap: false, extractable: false });
  }
  canWrap(allowed: boolean): void {
    kwPolicyOf(this).wrap = allowed;
  }
  canUnwrap(allowed: boolean): void {
    kwPolicyOf(this).unwrap = allowed;
  }
  extractable(allowed: boolean): void {
    kwPolicyOf(this).extractable = allowed;
  }
}

/** One-to-one with the platform's own AES-KW usages (reference: webcrypto.js:3125). */
function kwUsages(policy: KwPolicy): KeyUsage[] {
  return grantedUsages([
    ["wrapKey", policy.wrap],
    ["unwrapKey", policy.unwrap],
  ]);
}

function kwGrantedOps(policy: KwPolicy): string[] {
  const ops: string[] = [];
  if (policy.wrap) ops.push("wrapKey");
  if (policy.unwrap) ops.push("unwrapKey");
  return ops;
}

/** `key-wrap.kw-key` (reference: webcrypto.js:3166). */
export class KwKey {
  #key: CryptoKey;
  #lengthBits: number;
  #grants: KwPolicy;

  constructor(key: CryptoKey, lengthBits: number, grants: KwPolicy) {
    this.#key = key;
    this.#lengthBits = lengthBits;
    this.#grants = { ...grants };
  }

  /**
   * Encrypt serialized key material (RFC 3394). JWK-format material is
   * first padded with ASCII spaces to a multiple of 8 bytes — the `aes-kw`
   * WIT contract, carried back by the JWK contract's trailing-space
   * tolerance. Material outside the algorithm's input domain fails
   * `invalid-key` with a fixed message: the material is not the caller's
   * to see (reference: webcrypto.js:3188).
   */
  async wrap(input: WrapInput): Promise<Uint8Array> {
    const state = consumeWrapInput(input);
    if (!this.canWrap()) notPermitted("wrap");
    let bytes = state.bytes;
    if (state.format === "jwk" && bytes.length % 8 !== 0) {
      const padded = new Uint8Array(bytes.length + 8 - (bytes.length % 8));
      padded.set(bytes);
      padded.fill(0x20, bytes.length);
      bytes = padded;
    }
    if (bytes.length % 8 !== 0 || bytes.length < 16) {
      errInvalidKey("AES-KW wraps key material of at least 16 bytes, a multiple of 8");
    }
    const trampoline = await platformCall("AES-KW wrap", () =>
      subtle.importKey("raw", asBufferSource(bytes), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
    const wrapped = await platformCall("AES-KW wrap", () => subtle.wrapKey("raw", trampoline, this.#key, "AES-KW"));
    return new Uint8Array(wrapped);
  }

  /**
   * Decrypt and integrity-check wrapped material. Input that cannot carry
   * the RFC 3394 wire format reports the same detail-free
   * `authentication-failed` as an ICV failure, before the platform is
   * asked — the two verdicts are deliberately indistinguishable
   * (reference: webcrypto.js:3229).
   */
  async unwrap(wrapped: Uint8Array): Promise<UnwrapInput> {
    if (!this.canUnwrap()) notPermitted("unwrap");
    if (wrapped.length % 8 !== 0 || wrapped.length < 24) {
      errAuthenticationFailed();
    }
    let trampoline: CryptoKey;
    try {
      trampoline = await subtle.unwrapKey(
        "raw",
        asBufferSource(wrapped),
        this.#key,
        "AES-KW",
        { name: "HMAC", hash: "SHA-256" },
        true,
        ["sign"],
      );
    } catch (err) {
      decryptFailure(err, "unwrap");
    }
    const bytes = new Uint8Array(
      await platformCall("AES-KW unwrap", () => subtle.exportKey("raw", trampoline)),
    );
    return new UnwrapInput(bytes);
  }

  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  algorithmLength(): number {
    return this.#lengthBits;
  }
  extractable(): boolean {
    return this.#grants.extractable;
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

/** The `polymorph:webcrypto/key-wrap@0.1.0` interface: its resource classes. */
export const keyWrap = { KwKey, KwKeyOptions };

/** The `polymorph:webcrypto/aes-kw@0.1.0` interface (reference: webcrypto.js:3317). */
export const aesKw = {
  async importKeyRaw(variant: string, raw: Uint8Array, options: KwKeyOptions): Promise<KwKey> {
    const policy = kwPolicyOf(options);
    const usages = kwUsages(policy);
    const expected = aesVariantByteLength(variant);
    if (raw.length !== expected) {
      errInvalidKey(`${variant} requires ${expected} key bytes, got ${raw.length}`);
    }
    const key = await importPlatformKey(
      `${variant} key`,
      "raw",
      raw,
      { name: "AES-KW" },
      policy.extractable,
      usages,
    );
    return new KwKey(key, expected * 8, policy);
  },

  async importKeyJwk(variant: string, jwk: string, options: KwKeyOptions): Promise<KwKey> {
    const policy = kwPolicyOf(options);
    const usages = kwUsages(policy);
    const lengthBits = aesVariantByteLength(variant) * 8;
    const material = jwkMaterial(jwk);
    requireStrictBase64url(material.k);
    const key = await importPlatformKeyJwk(
      `${variant} JWK`,
      material,
      { name: "AES-KW" },
      policy.extractable,
      usages,
    );
    const gotBits = jwkKeyBytes(material.k) * 8;
    if (gotBits !== lengthBits) {
      errInvalidKey(`JWK carries a ${gotBits}-bit key; ${variant} requires ${lengthBits}`);
    }
    return new KwKey(key, lengthBits, policy);
  },

  async generateKey(variant: string, options: KwKeyOptions): Promise<KwKey> {
    const policy = kwPolicyOf(options);
    const usages = kwUsages(policy);
    const bits = aesVariantByteLength(variant) * 8;
    const key = await platformCall(`${variant} key generation`, () =>
      subtle.generateKey({ name: "AES-KW", length: bits }, policy.extractable, usages)) as CryptoKey;
    return new KwKey(key, bits, policy);
  },

  async deriveKey(variant: string, input: DeriveInput, options: KwKeyOptions): Promise<KwKey> {
    const policy = kwPolicyOf(options);
    const usages = kwUsages(policy);
    const bits = aesVariantByteLength(variant) * 8;
    const key = await deriveKeyFrom(input, { name: "AES-KW", length: bits }, policy.extractable, usages);
    return new KwKey(key, bits, policy);
  },

  unwrapKeyRaw(variant: string, input: UnwrapInput, options: KwKeyOptions): Promise<KwKey> {
    const { bytes } = consumeUnwrapInput(input);
    return redactingInvalidKey(
      `unwrapped ${variant} key material`,
      () => aesKw.importKeyRaw(variant, bytes, options),
    );
  },

  unwrapKeyJwk(variant: string, input: UnwrapInput, options: KwKeyOptions): Promise<KwKey> {
    const { bytes } = consumeUnwrapInput(input);
    const policy = kwPolicyOf(options);
    kwUsages(policy);
    const jwk = unwrappedJwk(bytes, "enc", kwGrantedOps(policy));
    return redactingInvalidKey(
      `unwrapped ${variant} JWK`,
      () => aesKw.importKeyJwk(variant, jwk, options),
    );
  },
};
