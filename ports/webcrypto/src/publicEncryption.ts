// `polymorph:webcrypto/public-encryption` plus `rsa-oaep-encrypt` /
// `rsa-oaep-decrypt` — wit/encryption.wit, wit/rsa.wit.
//
// Behavioral reference: js/jco/webcrypto.js:5367-6050.
//
// The decryption side's single-verdict rule is load-bearing: RFC 8017
// requires a wrong-length ciphertext, damaged padding, and a mismatched
// label to be INDISTINGUISHABLE, so every platform failure collapses to
// the detail-free `error.authentication-failed` — deliberately not the
// AEAD kinds' `decryptFailure`, whose classification is exactly the
// verdict distinction this kind's contract closes off.

import {
  errAuthenticationFailed,
  errInvalidKey,
  errNotExtractable,
  errOther,
  errUnsupported,
  grantedUsages,
  notPermitted,
  platformCall,
  witError,
} from "./errors.ts";
import { asBufferSource, unwrappedJwk } from "./util.ts";
import {
  importPlatformKey,
  importPlatformKeyJwk,
  jwkMaterial,
  redactingInvalidKey,
  requireRsaEncryptionSpki,
  requireStrictBase64url,
  served,
} from "./platform.ts";
import {
  RSA_MODULUS_BITS,
  RSA_VARIANTS,
  rsaAdmittedModulusLength,
  requireRsaJwkAlg,
  requireRsaPrivateKeysServed,
  rsaJwkAlgPrefix,
} from "./rsaSignature.ts";
import { consumeUnwrapInput, consumeWrapInput, UnwrapInput, WrapInput } from "./wrapping.ts";

const subtle = globalThis.crypto.subtle;

/** The RSA-OAEP admission window: encryption creates FUTURE artifacts, so there is no legacy tier (reference: webcrypto.js:5760). */
const RSA_OAEP_MIN_BITS = 2048;
const RSA_OAEP_MAX_BITS = 8192;

interface OaepAlgorithm {
  hash: string;
  modulusLength: number;
  /** RFC 8017 §7.1.1's `k − 2·hLen − 2`, enforced host-side. */
  plaintextBound: number;
}

/** The shared RSA admission checks at the OAEP window. */
function rsaOaepAdmitted(key: CryptoKey, what: string): number {
  return rsaAdmittedModulusLength(key, what, RSA_OAEP_MIN_BITS, RSA_OAEP_MAX_BITS);
}

function oaepAlgorithm(entry: { hash: string; digestBytes: number }, modulusLength: number): OaepAlgorithm {
  return {
    hash: entry.hash,
    modulusLength,
    plaintextBound: Math.ceil(modulusLength / 8) - 2 * entry.digestBytes - 2,
  };
}

/** The named plaintext-bound condition: the signal to switch to hybrid wrapping (reference: webcrypto.js:5461). */
function errMessageTooLong(what: string, length: number, algorithm: OaepAlgorithm): never {
  witError({
    tag: "extension",
    val: {
      origin: "polymorph:webcrypto",
      name: "message-too-long",
      message: `${what} is ${length} bytes; this key's RSA-OAEP bound is ${algorithm.plaintextBound}`,
    },
  });
}

/** `RsaOaepParams` for a per-call label; OAEP's default label is empty, so absent and empty are interchangeable. */
function oaepParams(label: Uint8Array | undefined): RsaOaepParams {
  return label === undefined
    ? { name: "RSA-OAEP" }
    : { name: "RSA-OAEP", label: asBufferSource(label) };
}

/** Every decryption failure is the one detail-free verdict (reference: webcrypto.js:5502). */
async function oaepDecrypt(
  key: CryptoKey,
  label: Uint8Array | undefined,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await subtle.decrypt(oaepParams(label), key, asBufferSource(ciphertext)));
  } catch {
    errAuthenticationFailed();
  }
}

/** `public-encryption.encryption-key`: public, secret-free, grant-free. */
export class EncryptionKey {
  #key: CryptoKey;
  #algorithm: OaepAlgorithm;

  constructor(key: CryptoKey, algorithm: OaepAlgorithm) {
    this.#key = key;
    this.#algorithm = algorithm;
  }

  async encrypt(label: Uint8Array | undefined, plaintext: Uint8Array): Promise<Uint8Array> {
    if (plaintext.length > this.#algorithm.plaintextBound) {
      errMessageTooLong("plaintext", plaintext.length, this.#algorithm);
    }
    const out = await platformCall("RSA-OAEP encrypt", () =>
      subtle.encrypt(oaepParams(label), this.#key, asBufferSource(plaintext)));
    return new Uint8Array(out);
  }

  async wrap(label: Uint8Array | undefined, input: WrapInput): Promise<Uint8Array> {
    const { bytes } = consumeWrapInput(input);
    if (bytes.length > this.#algorithm.plaintextBound) {
      errMessageTooLong("wrapped key material", bytes.length, this.#algorithm);
    }
    const out = await platformCall("RSA-OAEP wrap", () =>
      subtle.encrypt(oaepParams(label), this.#key, asBufferSource(bytes)));
    return new Uint8Array(out);
  }

  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  algorithmHash(): string | undefined {
    return this.#algorithm.hash;
  }
  algorithmLength(): number | undefined {
    return this.#algorithm.modulusLength;
  }
  algorithmPublicExponent(): Uint8Array | undefined {
    const e = (this.#key.algorithm as RsaHashedKeyAlgorithm).publicExponent;
    return e === undefined ? undefined : new Uint8Array(e);
  }

  exportKeyRaw(): Promise<Uint8Array> {
    errUnsupported("RSA public keys have no raw form");
  }
  async exportKeySpki(): Promise<Uint8Array> {
    const spki = await platformCall("spki key export", () => subtle.exportKey("spki", this.#key));
    return new Uint8Array(spki);
  }
  async exportKeyJwk(): Promise<string> {
    const jwk = await platformCall("jwk key export", () => subtle.exportKey("jwk", this.#key));
    return JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e });
  }
}

interface DecryptionPolicy {
  decrypt: boolean;
  unwrap: boolean;
  extractable: boolean;
}

const decryptionPolicies = new WeakMap<DecryptionKeyOptions, DecryptionPolicy>();

function decryptionPolicyOf(o: DecryptionKeyOptions): DecryptionPolicy {
  const p = decryptionPolicies.get(o);
  if (p === undefined) errOther("decryption-key-options minted by another provider");
  return p;
}

/** `public-encryption.decryption-key-options`. */
export class DecryptionKeyOptions {
  constructor() {
    decryptionPolicies.set(this, { decrypt: false, unwrap: false, extractable: false });
  }
  canDecrypt(allowed: boolean): void {
    decryptionPolicyOf(this).decrypt = allowed;
  }
  canUnwrap(allowed: boolean): void {
    decryptionPolicyOf(this).unwrap = allowed;
  }
  extractable(allowed: boolean): void {
    decryptionPolicyOf(this).extractable = allowed;
  }
}

/** Both WIT grants run `subtle.decrypt`, so they collapse onto one platform usage (reference: webcrypto.js:5400). */
function oaepPrivateUsages(policy: DecryptionPolicy): KeyUsage[] {
  return grantedUsages([["decrypt", policy.decrypt || policy.unwrap]]);
}

/** The granted operations' platform names, for the unwrap-path `key_ops` rule (reference: webcrypto.js:5420). */
function oaepGrantedOps(policy: DecryptionPolicy): string[] {
  const ops: string[] = [];
  if (policy.decrypt) ops.push("decrypt");
  if (policy.unwrap) ops.push("unwrapKey");
  return ops;
}

/** `public-encryption.decryption-key`. */
export class DecryptionKey {
  #key: CryptoKey;
  #algorithm: OaepAlgorithm;
  #grants: DecryptionPolicy;

  constructor(key: CryptoKey, algorithm: OaepAlgorithm, grants: DecryptionPolicy) {
    this.#key = key;
    this.#algorithm = algorithm;
    this.#grants = { ...grants };
  }

  decrypt(label: Uint8Array | undefined, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.canDecrypt()) notPermitted("decrypt");
    return oaepDecrypt(this.#key, label, ciphertext);
  }

  async unwrap(label: Uint8Array | undefined, ciphertext: Uint8Array): Promise<UnwrapInput> {
    if (!this.canUnwrap()) notPermitted("unwrap");
    return new UnwrapInput(await oaepDecrypt(this.#key, label, ciphertext));
  }

  algorithmName(): string {
    return this.#key.algorithm.name;
  }
  algorithmHash(): string | undefined {
    return this.#algorithm.hash;
  }
  algorithmLength(): number | undefined {
    return this.#algorithm.modulusLength;
  }
  algorithmPublicExponent(): Uint8Array | undefined {
    const e = (this.#key.algorithm as RsaHashedKeyAlgorithm).publicExponent;
    return e === undefined ? undefined : new Uint8Array(e);
  }
  canDecrypt(): boolean {
    return this.#grants.decrypt;
  }
  canUnwrap(): boolean {
    return this.#grants.unwrap;
  }
  extractable(): boolean {
    return this.#key.extractable;
  }

  async exportKeyJwk(): Promise<string> {
    if (!this.#key.extractable) errNotExtractable();
    const jwk = await platformCall("jwk key export", () => subtle.exportKey("jwk", this.#key));
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

/** The `polymorph:webcrypto/public-encryption@0.1.0` interface: its resource classes. */
export const publicEncryption = { EncryptionKey, DecryptionKey, DecryptionKeyOptions };

/** The `polymorph:webcrypto/rsa-oaep-encrypt@0.1.0` interface. */
export const rsaOaepEncrypt = {
  importEncryptionKeySpki: async (variant: string, spki: Uint8Array): Promise<EncryptionKey> => {
    const entry = served(RSA_VARIANTS, variant);
    requireRsaEncryptionSpki(spki);
    const key = await importPlatformKey(
      "RSA-OAEP spki",
      "spki",
      spki,
      { name: "RSA-OAEP", hash: entry.hash },
      true,
      ["encrypt"],
    );
    const modulusLength = rsaOaepAdmitted(key, "RSA-OAEP spki");
    return new EncryptionKey(key, oaepAlgorithm(entry, modulusLength));
  },
  importEncryptionKeyJwk: async (variant: string, jwkText: string): Promise<EncryptionKey> => {
    const entry = served(RSA_VARIANTS, variant);
    const jwk = jwkMaterial(jwkText);
    requireRsaJwkAlg(rsaJwkAlgPrefix("RSA-OAEP"), variant, jwk);
    requireStrictBase64url(jwk.n);
    requireStrictBase64url(jwk.e);
    const key = await importPlatformKeyJwk(
      "RSA-OAEP public JWK",
      jwk,
      { name: "RSA-OAEP", hash: entry.hash },
      true,
      ["encrypt"],
    );
    const modulusLength = rsaOaepAdmitted(key, "RSA-OAEP public JWK");
    return new EncryptionKey(key, oaepAlgorithm(entry, modulusLength));
  },
};

/** The `polymorph:webcrypto/rsa-oaep-decrypt@0.1.0` interface. */
export const rsaOaepDecrypt = {
  generateKey: async (
    variant: string,
    modulus: string,
    options: DecryptionKeyOptions,
  ): Promise<[DecryptionKey, EncryptionKey]> => {
    requireRsaPrivateKeysServed();
    const policy = decryptionPolicyOf(options);
    oaepPrivateUsages(policy);
    const entry = served(RSA_VARIANTS, variant);
    const modulusLength = served(RSA_MODULUS_BITS, modulus);
    const pair = await platformCall("RSA-OAEP key generation", () =>
      subtle.generateKey(
        { name: "RSA-OAEP", hash: entry.hash, modulusLength, publicExponent: new Uint8Array([1, 0, 1]) },
        policy.extractable,
        ["encrypt", "decrypt"],
      )) as CryptoKeyPair;
    const algorithm = oaepAlgorithm(entry, modulusLength);
    return [
      new DecryptionKey(pair.privateKey, algorithm, policy),
      new EncryptionKey(pair.publicKey, algorithm),
    ];
  },

  importDecryptionKeyPkcs8: async (
    variant: string,
    pkcs8: Uint8Array,
    options: DecryptionKeyOptions,
  ): Promise<DecryptionKey> => {
    requireRsaPrivateKeysServed();
    const policy = decryptionPolicyOf(options);
    const usages = oaepPrivateUsages(policy);
    const entry = served(RSA_VARIANTS, variant);
    const key = await importPlatformKey(
      "RSA-OAEP pkcs8",
      "pkcs8",
      pkcs8,
      { name: "RSA-OAEP", hash: entry.hash },
      policy.extractable,
      usages,
    );
    const modulusLength = rsaOaepAdmitted(key, "RSA-OAEP pkcs8");
    return new DecryptionKey(key, oaepAlgorithm(entry, modulusLength), policy);
  },

  importDecryptionKeyJwk: async (
    variant: string,
    jwkText: string,
    options: DecryptionKeyOptions,
  ): Promise<DecryptionKey> => {
    requireRsaPrivateKeysServed();
    const policy = decryptionPolicyOf(options);
    const usages = oaepPrivateUsages(policy);
    const entry = served(RSA_VARIANTS, variant);
    const jwk = jwkMaterial(jwkText);
    requireRsaJwkAlg(rsaJwkAlgPrefix("RSA-OAEP"), variant, jwk);
    for (const member of ["n", "e", "d", "p", "q", "dp", "dq", "qi"]) {
      requireStrictBase64url(jwk[member]);
    }
    const key = await importPlatformKeyJwk(
      "RSA-OAEP private JWK",
      jwk,
      { name: "RSA-OAEP", hash: entry.hash },
      policy.extractable,
      usages,
    );
    if (key.type !== "private") errInvalidKey("RSA private JWK must carry `d` and the CRT members");
    const modulusLength = rsaOaepAdmitted(key, "RSA-OAEP private JWK");
    return new DecryptionKey(key, oaepAlgorithm(entry, modulusLength), policy);
  },

  unwrapDecryptionKeyPkcs8: (
    variant: string,
    input: UnwrapInput,
    options: DecryptionKeyOptions,
  ): Promise<DecryptionKey> => {
    const { bytes } = consumeUnwrapInput(input);
    return redactingInvalidKey(
      "unwrapped RSA-OAEP pkcs8",
      () => rsaOaepDecrypt.importDecryptionKeyPkcs8(variant, bytes, options),
    );
  },

  unwrapDecryptionKeyJwk: (
    variant: string,
    input: UnwrapInput,
    options: DecryptionKeyOptions,
  ): Promise<DecryptionKey> => {
    const { bytes } = consumeUnwrapInput(input);
    const policy = decryptionPolicyOf(options);
    oaepPrivateUsages(policy);
    const jwk = unwrappedJwk(bytes, "enc", oaepGrantedOps(policy));
    return redactingInvalidKey(
      "unwrapped RSA-OAEP private JWK",
      () => rsaOaepDecrypt.importDecryptionKeyJwk(variant, jwk, options),
    );
  },
};
