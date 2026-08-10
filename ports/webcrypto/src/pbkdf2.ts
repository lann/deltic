// `polymorph:webcrypto/pbkdf2` plus `pbkdf2-sha1` / `pbkdf2-sha2` —
// wit/pbkdf2.wit.
//
// Behavioral reference: js/jco/webcrypto.js:1556-1665. Empty passwords are
// accepted (RFC 8018 admits an empty `P` and the platform serves it) —
// the documented asymmetry with `hkdf.import-ikm`. A zero iteration count
// fails at `prepare`, not at use, so a misparameterized input cannot mint.

import { errOther, platformCall } from "./errors.ts";
import {
  DeriveInput,
  type DeriveOptions,
  type DerivePolicy,
  deriveUsages,
  mintDeriveInput,
  readDerivePolicy,
} from "./derivation.ts";
import { asBufferSource } from "./util.ts";
import { redactingInvalidKey, served, SHA1_ENTRY, SHA2_VARIANTS } from "./platform.ts";
import { consumeUnwrapInput, type UnwrapInput } from "./wrapping.ts";

const subtle = globalThis.crypto.subtle;

const passwordState = new WeakMap<Password, { key: CryptoKey; policy: DerivePolicy }>();

function passwordOf(p: Password): { key: CryptoKey; policy: DerivePolicy } {
  const state = passwordState.get(p);
  if (state === undefined) errOther("password minted by another provider");
  return state;
}

/**
 * `pbkdf2.password`: a password as a `PBKDF2`-bound platform key. The
 * platform forces non-extractability at import, and the WIT grants ride
 * the key's usages (reference: webcrypto.js:1570).
 */
export class Password {
  canDeriveBits(): boolean {
    return passwordOf(this).policy.deriveBits;
  }
  canDeriveKey(): boolean {
    return passwordOf(this).policy.deriveKey;
  }
}

async function importPassword(raw: Uint8Array, options: DeriveOptions): Promise<Password> {
  const policy = readDerivePolicy(options);
  const usages = deriveUsages(policy);
  const key = await platformCall("PBKDF2 password import", () =>
    subtle.importKey("raw", asBufferSource(raw), "PBKDF2", false, usages));
  const password = new Password();
  passwordState.set(password, { key, policy });
  return password;
}

/** The `polymorph:webcrypto/pbkdf2@0.1.0` interface. */
export const pbkdf2 = {
  Password,
  importPassword,
  unwrapPassword: (input: UnwrapInput, options: DeriveOptions): Promise<Password> => {
    const { bytes } = consumeUnwrapInput(input);
    return redactingInvalidKey("unwrapped PBKDF2 password", () => importPassword(bytes, options));
  },
};

/** `prepare` (reference: webcrypto.js:1615): salt and work factor bound now, output length per use. */
function preparePbkdf2(hash: string, input: Password, salt: Uint8Array, iterations: number): DeriveInput {
  if (iterations === 0) {
    errOther("PBKDF2 requires a positive iteration count");
  }
  const { key, policy } = passwordOf(input);
  const params = { name: "PBKDF2", hash, salt: asBufferSource(salt.slice()), iterations };
  // PBKDF2 has no natural output length: every derivation is a caller
  // choice, so `derive-bits(none)` is refused by `DeriveInput` itself.
  return mintDeriveInput(key, params, policy, /* hasNaturalLength */ false);
}

/** The `polymorph:webcrypto/pbkdf2-sha2@0.1.0` interface. */
export const pbkdf2Sha2 = {
  prepare: (variant: string, input: Password, salt: Uint8Array, iterations: number): Promise<DeriveInput> =>
    Promise.resolve(preparePbkdf2(served(SHA2_VARIANTS, variant).hash, input, salt, iterations)),
};

/** The `polymorph:webcrypto/pbkdf2-sha1@0.1.0` interface. */
export const pbkdf2Sha1 = {
  prepare: (input: Password, salt: Uint8Array, iterations: number): Promise<DeriveInput> =>
    Promise.resolve(preparePbkdf2(SHA1_ENTRY.hash, input, salt, iterations)),
};
