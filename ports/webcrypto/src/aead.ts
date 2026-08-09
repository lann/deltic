// `polymorph:webcrypto/aead` (algorithm-agnostic AEAD resources) plus
// `aes-gcm` — wit/webcrypto.wit `interface aead`, wit/aes.wit `interface
// aes-gcm`. `aes-cbc`/`aes-ctr`/`aes-kw` (the `cipher`/`key-wrap` kinds) are
// NOT ported (time-boxed scope cut — see the mission report's coverage
// table, not a Deno `crypto.subtle` gap: Deno serves AES-CBC/CTR too).

import { decryptFailure, errInvalidKey, errInvalidNonce, errNotExtractable, errNotPermitted, errOther, errUnsupported, notPermitted, platformCall } from "./errors.ts";
import { asBufferSource, collectByteStream, unwrappedJwk } from "./util.ts";
import { deriveKeyFrom, type DeriveInput } from "./derivation.ts";
import {
  consumeUnwrapInput,
  consumeWrapInput,
  UnwrapInput,
  type WrapInput as WrapInputT,
  WrapInput,
} from "./wrapping.ts";
import type { Stream } from "../../../runtime/src/embedder/mod.ts";

const subtle = globalThis.crypto.subtle;

interface AeadPolicy {
  seal: boolean;
  open: boolean;
  wrap: boolean;
  unwrap: boolean;
  extractable: boolean;
}

const optionsState = new WeakMap<AeadKeyOptions, AeadPolicy>();

function optionsOf(o: AeadKeyOptions): AeadPolicy {
  const p = optionsState.get(o);
  if (p === undefined) errOther("aead-key-options minted by another provider");
  return p;
}

/** `aead.aead-key-options`. */
export class AeadKeyOptions {
  constructor() {
    optionsState.set(this, { seal: false, open: false, wrap: false, unwrap: false, extractable: false });
  }
  canSeal(allowed: boolean): void {
    optionsOf(this).seal = allowed;
  }
  canOpen(allowed: boolean): void {
    optionsOf(this).open = allowed;
  }
  canWrap(allowed: boolean): void {
    optionsOf(this).wrap = allowed;
  }
  canUnwrap(allowed: boolean): void {
    optionsOf(this).unwrap = allowed;
  }
  extractable(allowed: boolean): void {
    optionsOf(this).extractable = allowed;
  }
}

/**
 * The platform usages a mint needs: `wrap` runs `subtle.encrypt` and
 * `unwrap` runs `subtle.decrypt` (WebCrypto's `wrapKey`-with-an-
 * encryption-algorithm model), so the platform key carries `encrypt` if
 * (seal or wrap) and `decrypt` if (open or unwrap); the WIT grants are
 * enforced host-side against `grants` (reference: js/jco/webcrypto.js
 * `aeadKeyGrants`, lines 595-607).
 */
function platformUsages(policy: AeadPolicy): KeyUsage[] {
  const usages: KeyUsage[] = [];
  if (policy.seal || policy.wrap) usages.push("encrypt");
  if (policy.open || policy.unwrap) usages.push("decrypt");
  if (usages.length === 0) errNotPermitted("a key with no enabled usage cannot be minted");
  return usages;
}

const GCM_TAG_BITS = new Set([32, 64, 96, 104, 112, 120, 128]);

function gcmTagLengthBits(tagSize: number | undefined): number {
  if (tagSize === undefined) return 128;
  const bits = tagSize * 8;
  if (!GCM_TAG_BITS.has(bits)) {
    errUnsupported(`AES-GCM tag size ${tagSize} bytes is outside the registry's 32-128 bit set`);
  }
  return bits;
}

/** `aead.aead-key`: an AES-GCM key bound to a length at mint. */
export class AeadKey {
  #key: CryptoKey;
  #lengthBits: number;
  #grants: AeadPolicy;

  constructor(key: CryptoKey, lengthBits: number, grants: AeadPolicy) {
    this.#key = key;
    this.#lengthBits = lengthBits;
    this.#grants = { ...grants };
  }

  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  algorithmLength(): number {
    return this.#lengthBits;
  }
  nonceSize(): number {
    return 12;
  }
  tagSize(): number {
    return 16;
  }
  extractable(): boolean {
    return this.#key.extractable;
  }
  canSeal(): boolean {
    return this.#grants.seal;
  }
  canOpen(): boolean {
    return this.#grants.open;
  }
  canWrap(): boolean {
    return this.#grants.wrap;
  }
  canUnwrap(): boolean {
    return this.#grants.unwrap;
  }

  async #sealOpen(
    direction: "seal" | "open",
    nonce: Uint8Array,
    aad: Uint8Array,
    tagSize: number | undefined,
    message: Uint8Array,
    operation: string = direction,
  ): Promise<Uint8Array> {
    if (nonce.length < 12 || nonce.length > 128) {
      errInvalidNonce(`AES-GCM nonce must be 12 to 128 bytes, got ${nonce.length}`);
    }
    const params: AesGcmParams = {
      name: "AES-GCM",
      iv: asBufferSource(nonce),
      additionalData: asBufferSource(aad),
      tagLength: gcmTagLengthBits(tagSize),
    };
    if (direction === "seal") {
      const out = await platformCall(`AES-GCM ${operation}`, () =>
        subtle.encrypt(params, this.#key, asBufferSource(message)));
      return new Uint8Array(out);
    }
    try {
      const out = await subtle.decrypt(params, this.#key, asBufferSource(message));
      return new Uint8Array(out);
    } catch (err) {
      decryptFailure(err, operation);
    }
  }

  async seal(nonce: Uint8Array, aad: Uint8Array, tagSize: number | undefined, plaintext: Stream<number>): Promise<Uint8Array> {
    const message = await collectByteStream(plaintext);
    if (!this.canSeal()) notPermitted("seal");
    return this.#sealOpen("seal", nonce, aad, tagSize, message);
  }

  async open(nonce: Uint8Array, aad: Uint8Array, tagSize: number | undefined, ciphertext: Stream<number>): Promise<Uint8Array> {
    const message = await collectByteStream(ciphertext);
    if (!this.canOpen()) notPermitted("open");
    return this.#sealOpen("open", nonce, aad, tagSize, message);
  }

  async wrap(nonce: Uint8Array, aad: Uint8Array, tagSize: number | undefined, input: WrapInputT): Promise<Uint8Array> {
    const { bytes } = consumeWrapInput(input);
    if (!this.canWrap()) notPermitted("wrap");
    return this.#sealOpen("seal", nonce, aad, tagSize, bytes, "wrap");
  }

  async unwrap(
    nonce: Uint8Array,
    aad: Uint8Array,
    tagSize: number | undefined,
    wrapped: Uint8Array,
  ): Promise<UnwrapInput> {
    if (!this.canUnwrap()) notPermitted("unwrap");
    const plaintext = await this.#sealOpen("open", nonce, aad, tagSize, wrapped, "unwrap");
    return new UnwrapInput(plaintext);
  }

  async exportKeyRaw(): Promise<Uint8Array> {
    if (!this.#key.extractable) {
      errNotExtractable();
    }
    const raw = await platformCall("export raw", () => subtle.exportKey("raw", this.#key));
    return new Uint8Array(raw);
  }
  async exportKeyJwk(): Promise<string> {
    if (!this.#key.extractable) {
      errNotExtractable();
    }
    const jwk = await platformCall("export jwk", () => subtle.exportKey("jwk", this.#key));
    return JSON.stringify(jwk);
  }
  async toWrapInputRaw(): Promise<WrapInput> {
    return new WrapInput("raw", await this.exportKeyRaw());
  }
  async toWrapInputJwk(): Promise<WrapInput> {
    const jwk = await this.exportKeyJwk();
    return new WrapInput("jwk", new TextEncoder().encode(jwk));
  }
}

/** The `polymorph:webcrypto/aead@0.1.0` interface: its resource classes. */
export const aead = { AeadKey, AeadKeyOptions };

const AES_BITS: Readonly<Record<string, number | undefined>> = Object.freeze({
  aes128: 128,
  // aes192 is declined package-wide (wit/aes.wit `aes-variant` doc): no
  // major browser engine serves it, and Deno's V8-backed WebCrypto follows
  // suit — this is the port honoring the WIT's own portability ruling, not
  // an incidental Deno gap.
  aes256: 256,
});

function aesBits(variant: string): number {
  const bits = AES_BITS[variant];
  if (bits === undefined) errUnsupported(`${variant} is not served by this implementation`);
  return bits;
}

async function importAesGcmKey(bits: number, raw: Uint8Array, options: AeadKeyOptions): Promise<AeadKey> {
  const policy = optionsOf(options);
  if (raw.length * 8 !== bits) {
    errInvalidKey(`AES-GCM key must be ${bits / 8} bytes for the declared variant, got ${raw.length}`);
  }
  const usages = platformUsages(policy);
  const key = await platformCall("AES-GCM import key", () =>
    subtle.importKey("raw", asBufferSource(raw), { name: "AES-GCM", length: bits }, policy.extractable, usages));
  return new AeadKey(key as CryptoKey, bits, policy);
}

/** The `polymorph:webcrypto/aes-gcm@0.1.0` interface. */
export const aesGcm = {
  importKeyRaw: (variant: string, raw: Uint8Array, options: AeadKeyOptions) =>
    importAesGcmKey(aesBits(variant), raw, options),
  importKeyJwk: async (variant: string, jwk: string, options: AeadKeyOptions): Promise<AeadKey> => {
    const bits = aesBits(variant);
    const policy = optionsOf(options);
    const usages = platformUsages(policy);
    const key = await platformCall("AES-GCM import jwk", () =>
      subtle.importKey("jwk", JSON.parse(jwk), { name: "AES-GCM", length: bits }, policy.extractable, usages));
    return new AeadKey(key as CryptoKey, bits, policy);
  },
  generateKey: async (variant: string, options: AeadKeyOptions): Promise<AeadKey> => {
    const bits = aesBits(variant);
    const policy = optionsOf(options);
    const usages = platformUsages(policy);
    const key = await platformCall(`AES-${bits}-GCM key generation`, () =>
      subtle.generateKey({ name: "AES-GCM", length: bits }, policy.extractable, usages));
    return new AeadKey(key as CryptoKey, bits, policy);
  },
  deriveKey: async (variant: string, input: DeriveInput, options: AeadKeyOptions): Promise<AeadKey> => {
    const bits = aesBits(variant);
    const policy = optionsOf(options);
    const usages = platformUsages(policy);
    const key = await deriveKeyFrom(input, { name: "AES-GCM", length: bits }, policy.extractable, usages);
    return new AeadKey(key, bits, policy);
  },
  unwrapKeyRaw: (variant: string, input: UnwrapInput, options: AeadKeyOptions) => {
    const { bytes } = consumeUnwrapInput(input);
    return importAesGcmKey(aesBits(variant), bytes, options);
  },
  unwrapKeyJwk: (variant: string, input: UnwrapInput, options: AeadKeyOptions) => {
    const { bytes } = consumeUnwrapInput(input);
    const policy = optionsOf(options);
    const jwk = unwrappedJwk(bytes, "enc", platformUsages(policy));
    return aesGcm.importKeyJwk(variant, jwk, options);
  },
};
