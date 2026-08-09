// `polymorph:webcrypto/mac` (algorithm-agnostic MAC key resource) plus
// `hmac-sha2` / `hmac-sha1` (the two minting interfaces) — wit/webcrypto.wit
// `interface mac`, wit/hmac.wit.

import {
  errAuthenticationFailed,
  errInvalidKey,
  errNotExtractable,
  errNotPermitted,
  errOther,
  errUnsupported,
  notPermitted,
  platformCall,
} from "./errors.ts";
import { asBufferSource, unwrappedJwk, utf8Encode } from "./util.ts";
import { deriveKeyFrom, type DeriveInput } from "./derivation.ts";
import { consumeUnwrapInput, type UnwrapInput, WrapInput } from "./wrapping.ts";
import type { Stream } from "../../../runtime/src/embedder/mod.ts";
import { collectByteStream } from "./util.ts";

const subtle = globalThis.crypto.subtle;

interface MacPolicy {
  sign: boolean;
  verify: boolean;
  extractable: boolean;
}

const macPolicies = new WeakMap<MacKeyOptions, MacPolicy>();

function policyOf(o: MacKeyOptions): MacPolicy {
  const p = macPolicies.get(o);
  if (p === undefined) {
    errOther("mac-key-options minted by another provider");
  }
  return p;
}

/** `mac.mac-key-options`: mint-time policy, granting nothing by default. */
export class MacKeyOptions {
  constructor() {
    macPolicies.set(this, { sign: false, verify: false, extractable: false });
  }
  canSign(allowed: boolean): void {
    policyOf(this).sign = allowed;
  }
  canVerify(allowed: boolean): void {
    policyOf(this).verify = allowed;
  }
  extractable(allowed: boolean): void {
    policyOf(this).extractable = allowed;
  }
}

function macUsages(policy: MacPolicy): KeyUsage[] {
  const usages: KeyUsage[] = [];
  if (policy.sign) usages.push("sign");
  if (policy.verify) usages.push("verify");
  if (usages.length === 0) {
    errNotPermitted("a key with no enabled usage cannot be minted");
  }
  return usages;
}

interface HashSpec {
  hash: string;
  blockBytes: number;
}

/** `mac.mac-key`: an HMAC key bound to a hash at mint. */
export class MacKey {
  #key: CryptoKey;
  #lengthBits: number;
  #hashName: string;

  constructor(key: CryptoKey, lengthBits: number, hashName: string) {
    this.#key = key;
    this.#lengthBits = lengthBits;
    this.#hashName = hashName;
  }

  extractable(): boolean {
    return this.#key.extractable;
  }
  canSign(): boolean {
    return this.#key.usages.includes("sign");
  }
  canVerify(): boolean {
    return this.#key.usages.includes("verify");
  }
  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  algorithmHash(): string | undefined {
    return this.#hashName;
  }
  algorithmLength(): number {
    return this.#lengthBits;
  }

  async sign(data: Stream<number>): Promise<Uint8Array> {
    const message = await collectByteStream(data);
    if (!this.canSign()) notPermitted("sign");
    const out = await platformCall("HMAC sign", () => subtle.sign("HMAC", this.#key, asBufferSource(message)));
    return new Uint8Array(out);
  }

  async verify(data: Stream<number>, tag: Uint8Array): Promise<void> {
    const message = await collectByteStream(data);
    if (!this.canVerify()) notPermitted("verify");
    const ok = await platformCall("HMAC verify", () =>
      subtle.verify("HMAC", this.#key, asBufferSource(tag), asBufferSource(message)));
    if (!ok) {
      errAuthenticationFailed();
    }
  }

  async exportKeyRaw(): Promise<Uint8Array> {
    return exportRawGated(this.#key);
  }
  async exportKeyJwk(): Promise<string> {
    return exportJwkGated(this.#key);
  }
  async toWrapInputRaw(): Promise<WrapInput> {
    return new WrapInput("raw", await exportRawGated(this.#key));
  }
  async toWrapInputJwk(): Promise<WrapInput> {
    const jwk = await exportJwkGated(this.#key);
    return new WrapInput("jwk", utf8Encode(jwk));
  }
}

/** The `error.not-extractable` gate shared by every export path (reference: js/jco/webcrypto.js `exportRawGated`-style helpers). */
async function exportRawGated(key: CryptoKey): Promise<Uint8Array> {
  if (!key.extractable) {
    errNotExtractable();
  }
  const raw = await platformCall("export raw", () => subtle.exportKey("raw", key));
  return new Uint8Array(raw);
}

async function exportJwkGated(key: CryptoKey): Promise<string> {
  if (!key.extractable) {
    errNotExtractable();
  }
  const jwk = await platformCall("export jwk", () => subtle.exportKey("jwk", key));
  return JSON.stringify(jwk);
}

/** The `polymorph:webcrypto/mac@0.1.0` interface: its resource classes. */
export const mac = { MacKey, MacKeyOptions };

async function importHmacKey(resolved: HashSpec, raw: Uint8Array, options: MacKeyOptions): Promise<MacKey> {
  const policy = policyOf(options);
  const usages = macUsages(policy);
  if (raw.length === 0) errInvalidKey("empty key");
  const key = await platformCall("HMAC import key", () =>
    subtle.importKey("raw", asBufferSource(raw), { name: "HMAC", hash: resolved.hash }, policy.extractable, usages));
  return new MacKey(key, raw.length * 8, resolved.hash);
}

async function generateHmacKey(
  resolved: HashSpec,
  length: number | undefined,
  options: MacKeyOptions,
): Promise<MacKey> {
  const policy = policyOf(options);
  const usages = macUsages(policy);
  if (length === 0) errInvalidKey("HMAC key length must be non-zero");
  if (length !== undefined && length % 8 !== 0) {
    errUnsupported(`HMAC key length ${length} is not a multiple of 8; sub-byte lengths are not served`);
  }
  const bits = length ?? resolved.blockBytes * 8;
  const key = await platformCall(`HMAC-${resolved.hash} key generation`, () =>
    subtle.generateKey({ name: "HMAC", hash: resolved.hash, length: bits }, policy.extractable, usages));
  return new MacKey(key as CryptoKey, bits, resolved.hash);
}

function jwkKeyBytes(k: string): number {
  // base64url length -> decoded byte count (RFC 4648 §5, no padding).
  return Math.floor((k.length * 3) / 4);
}

async function importHmacKeyJwk(resolved: HashSpec, jwk: string, options: MacKeyOptions): Promise<MacKey> {
  const policy = policyOf(options);
  const usages = macUsages(policy);
  let material: { k?: string };
  try {
    material = JSON.parse(jwk);
  } catch {
    errInvalidKey("HMAC JWK is not valid JSON");
  }
  const key = await platformCall("HMAC import jwk", () =>
    subtle.importKey(
      "jwk",
      JSON.parse(jwk),
      { name: "HMAC", hash: resolved.hash },
      policy.extractable,
      usages,
    ));
  const kLen = material.k !== undefined ? jwkKeyBytes(material.k) * 8 : 0;
  return new MacKey(key as CryptoKey, kLen, resolved.hash);
}

async function deriveHmacKey(
  resolved: HashSpec,
  input: DeriveInput,
  length: number | undefined,
  options: MacKeyOptions,
): Promise<MacKey> {
  const policy = policyOf(options);
  const usages = macUsages(policy);
  if (length === 0) errInvalidKey("HMAC key length must be non-zero");
  if (length !== undefined && length % 8 !== 0) {
    errUnsupported(`HMAC key length ${length} is not a multiple of 8; sub-byte lengths are not served`);
  }
  const bits = length ?? resolved.blockBytes * 8;
  const key = await deriveKeyFrom(input, { name: "HMAC", hash: resolved.hash, length: bits }, policy.extractable, usages);
  return new MacKey(key, bits, resolved.hash);
}

function unwrapHmacKeyRaw(resolved: HashSpec, input: UnwrapInput, options: MacKeyOptions): Promise<MacKey> {
  const { bytes } = consumeUnwrapInput(input);
  return importHmacKey(resolved, bytes, options);
}

function unwrapHmacKeyJwk(resolved: HashSpec, input: UnwrapInput, options: MacKeyOptions): Promise<MacKey> {
  const { bytes } = consumeUnwrapInput(input);
  const policy = policyOf(options);
  const jwk = unwrappedJwk(bytes, "sig", macUsages(policy));
  return importHmacKeyJwk(resolved, jwk, options);
}

const SHA1_HMAC: HashSpec = { hash: "SHA-1", blockBytes: 64 };

const SHA2_HMAC: Readonly<Record<string, HashSpec | undefined>> = Object.freeze({
  sha256: { hash: "SHA-256", blockBytes: 64 },
  sha384: { hash: "SHA-384", blockBytes: 128 },
  sha512: { hash: "SHA-512", blockBytes: 128 },
});

function sha2Hmac(variant: string): HashSpec {
  const spec = SHA2_HMAC[variant];
  if (spec === undefined) errUnsupported(`${variant} is not served by this implementation`);
  return spec;
}

/** The `polymorph:webcrypto/hmac-sha1@0.1.0` interface. */
export const hmacSha1 = {
  importKeyRaw: (raw: Uint8Array, options: MacKeyOptions) => importHmacKey(SHA1_HMAC, raw, options),
  importKeyJwk: (jwk: string, options: MacKeyOptions) => importHmacKeyJwk(SHA1_HMAC, jwk, options),
  generateKey: (length: number | undefined, options: MacKeyOptions) => generateHmacKey(SHA1_HMAC, length, options),
  deriveKey: (input: DeriveInput, length: number | undefined, options: MacKeyOptions) =>
    deriveHmacKey(SHA1_HMAC, input, length, options),
  unwrapKeyRaw: (input: UnwrapInput, options: MacKeyOptions) => unwrapHmacKeyRaw(SHA1_HMAC, input, options),
  unwrapKeyJwk: (input: UnwrapInput, options: MacKeyOptions) => unwrapHmacKeyJwk(SHA1_HMAC, input, options),
};

/** The `polymorph:webcrypto/hmac-sha2@0.1.0` interface. */
export const hmacSha2 = {
  importKeyRaw: (variant: string, raw: Uint8Array, options: MacKeyOptions) =>
    importHmacKey(sha2Hmac(variant), raw, options),
  importKeyJwk: (variant: string, jwk: string, options: MacKeyOptions) =>
    importHmacKeyJwk(sha2Hmac(variant), jwk, options),
  generateKey: (variant: string, length: number | undefined, options: MacKeyOptions) =>
    generateHmacKey(sha2Hmac(variant), length, options),
  deriveKey: (variant: string, input: DeriveInput, length: number | undefined, options: MacKeyOptions) =>
    deriveHmacKey(sha2Hmac(variant), input, length, options),
  unwrapKeyRaw: (variant: string, input: UnwrapInput, options: MacKeyOptions) =>
    unwrapHmacKeyRaw(sha2Hmac(variant), input, options),
  unwrapKeyJwk: (variant: string, input: UnwrapInput, options: MacKeyOptions) =>
    unwrapHmacKeyJwk(sha2Hmac(variant), input, options),
};
