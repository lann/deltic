// `polymorph:webcrypto/hkdf` + `hkdf-sha2` + `hkdf-sha1` — wit/hkdf.wit.

import { errOther, errUnsupported, notPermitted, platformCall } from "./errors.ts";
import {
  DeriveInput,
  type DerivePolicy,
  deriveUsages,
  inputStateOf,
  mintDeriveInput,
  readDerivePolicy,
} from "./derivation.ts";
import { consumeUnwrapInput, type UnwrapInput } from "./wrapping.ts";
import { asBufferSource } from "./util.ts";
import type { DeriveOptions } from "./derivation.ts";

const subtle = globalThis.crypto.subtle;

const ikmState = new WeakMap<Ikm, { key: CryptoKey; policy: DerivePolicy }>();

/** `hkdf.ikm`: input keying material, consumable only by `prepare`. */
export class Ikm {
  canDeriveBits(): boolean {
    return ikmState.get(this)!.policy.deriveBits;
  }
  canDeriveKey(): boolean {
    return ikmState.get(this)!.policy.deriveKey;
  }
}

function mintIkm(key: CryptoKey, policy: DerivePolicy): Ikm {
  const ikm = new Ikm();
  ikmState.set(ikm, { key, policy: { ...policy } });
  return ikm;
}

async function importIkmKey(raw: Uint8Array, options: DeriveOptions): Promise<Ikm> {
  const policy = readPolicy(options);
  const usages = deriveUsages(policy);
  const key = await platformCall("HKDF import ikm", () =>
    subtle.importKey("raw", asBufferSource(raw), "HKDF", false, usages));
  return mintIkm(key, policy);
}

// `DeriveOptions` exposes only mint-time setters per the WIT; `hkdf`'s
// `import-ikm`/`unwrap-ikm` need the accumulated policy to mint an `ikm`,
// so `derivation.ts` exports a read accessor rather than this module
// re-deriving it by hand.
function readPolicy(options: DeriveOptions): DerivePolicy {
  return readDerivePolicy(options);
}

/** The `polymorph:webcrypto/hkdf@0.1.0` interface. */
export const hkdf = {
  Ikm,
  importIkm: (raw: Uint8Array, options: DeriveOptions) => importIkmKey(raw, options),
  unwrapIkm: (input: UnwrapInput, options: DeriveOptions) => {
    const { bytes } = consumeUnwrapInput(input);
    return importIkmKey(bytes, options);
  },
};

const SHA2_HASH: Readonly<Record<string, string | undefined>> = Object.freeze({
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
});

function sha2Hash(variant: string): string {
  const hash = SHA2_HASH[variant];
  if (hash === undefined) errUnsupported(`${variant} is not served by this implementation`);
  return hash;
}

async function prepare(hash: string, input: Ikm, salt: Uint8Array, info: Uint8Array): Promise<DeriveInput> {
  const state = ikmState.get(input);
  if (state === undefined) {
    errOther("ikm minted by another provider");
  }
  const params = {
    name: "HKDF",
    hash,
    salt: asBufferSource(salt.slice()),
    info: asBufferSource(info.slice()),
  };
  return mintDeriveInput(state.key, params, state.policy, /* hasNaturalLength */ false);
}

async function prepareFrom(
  hash: string,
  input: DeriveInput,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<DeriveInput> {
  const upstream = inputStateOf(input);
  if (!upstream.policy.deriveKey) notPermitted("derive-key");
  if (!upstream.hasNaturalLength) {
    errOther(
      "chaining from another KDF's input is not served: a KDF's output length is a caller choice, not natural",
    );
  }
  const secret = await subtle.deriveBits(upstream.params, upstream.key, null as unknown as number);
  const key = await subtle.importKey("raw", secret, "HKDF", false, deriveUsages(upstream.policy));
  const params = {
    name: "HKDF",
    hash,
    salt: asBufferSource(salt.slice()),
    info: asBufferSource(info.slice()),
  };
  return mintDeriveInput(key, params, upstream.policy, false);
}

/** The `polymorph:webcrypto/hkdf-sha2@0.1.0` interface. */
export const hkdfSha2 = {
  prepare: (variant: string, input: Ikm, salt: Uint8Array, info: Uint8Array) =>
    prepare(sha2Hash(variant), input, salt, info),
  prepareFrom: (variant: string, input: DeriveInput, salt: Uint8Array, info: Uint8Array) =>
    prepareFrom(sha2Hash(variant), input, salt, info),
};

/** The `polymorph:webcrypto/hkdf-sha1@0.1.0` interface. */
export const hkdfSha1 = {
  prepare: (input: Ikm, salt: Uint8Array, info: Uint8Array) => prepare("SHA-1", input, salt, info),
  prepareFrom: (input: DeriveInput, salt: Uint8Array, info: Uint8Array) => prepareFrom("SHA-1", input, salt, info),
};
