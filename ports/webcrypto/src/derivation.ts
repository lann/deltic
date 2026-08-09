// `polymorph:webcrypto/derivation` — wit/derivation.wit.
//
// `derive-input` is the spec's (base key, normalized params) pair as a
// resource. Sources (`hkdf-sha2.prepare`, `x25519`/`key-agreement.agree`)
// construct it; targets (`aes-gcm.derive-key`, `hmac-sha2.derive-key`,
// `derive-input.derive-bits` itself) consume it. Kept in its own module
// (rather than folded into `hkdf.ts` or `keyAgreement.ts`) because both
// source families mint the same resource type.

import { errNotPermitted, errOther, notPermitted, platformCall } from "./errors.ts";

const subtle = globalThis.crypto.subtle;

export interface DerivePolicy {
  deriveBits: boolean;
  deriveKey: boolean;
}

const derivePolicies = new WeakMap<DeriveOptions, DerivePolicy>();

function derivePolicyOf(o: DeriveOptions): DerivePolicy {
  const p = derivePolicies.get(o);
  if (p === undefined) errOther("derive-options minted by another provider");
  return p;
}

/** `derivation.derive-options`: mint-time policy, granting nothing by default (package-wide options contract). */
export class DeriveOptions {
  constructor() {
    derivePolicies.set(this, { deriveBits: false, deriveKey: false });
  }
  canDeriveBits(allowed: boolean): void {
    derivePolicyOf(this).deriveBits = allowed;
  }
  canDeriveKey(allowed: boolean): void {
    derivePolicyOf(this).deriveKey = allowed;
  }
}

/** The policy accumulated on a `derive-options` (read by `hkdf.ts`'s `import-ikm`/`unwrap-ikm`). */
export function readDerivePolicy(o: DeriveOptions): DerivePolicy {
  return { ...derivePolicyOf(o) };
}

/** The platform usage pair for a derive policy (WebCrypto's derive-capable-key usages). */
export function deriveUsages(policy: DerivePolicy): KeyUsage[] {
  const usages: KeyUsage[] = [];
  if (policy.deriveBits) usages.push("deriveBits");
  if (policy.deriveKey) usages.push("deriveKey");
  if (usages.length === 0) {
    errNotPermitted("an options resource granting nothing cannot mint");
  }
  return usages;
}

interface DeriveInputState {
  key: CryptoKey;
  // deno-lint-ignore no-explicit-any
  params: any;
  policy: DerivePolicy;
  /** Whether `params` denotes an agreement (has a natural output length). */
  hasNaturalLength: boolean;
}

const inputState = new WeakMap<DeriveInput, DeriveInputState>();

function inputOf(i: DeriveInput): DeriveInputState {
  const s = inputState.get(i);
  if (s === undefined) errOther("derive-input minted by another provider");
  return s;
}

/** Construct a `derive-input` (called only by `hkdf`/`keyAgreement` sources). */
export function mintDeriveInput(
  key: CryptoKey,
  // deno-lint-ignore no-explicit-any
  params: any,
  policy: DerivePolicy,
  hasNaturalLength: boolean,
): DeriveInput {
  const input = new DeriveInput();
  inputState.set(input, { key, params: { ...params }, policy: { ...policy }, hasNaturalLength });
  return input;
}

/** `derivation.derive-input`. */
export class DeriveInput {
  canDeriveBits(): boolean {
    return inputOf(this).policy.deriveBits;
  }
  canDeriveKey(): boolean {
    return inputOf(this).policy.deriveKey;
  }

  async deriveBits(length: number | undefined): Promise<Uint8Array> {
    const state = inputOf(this);
    if (!state.policy.deriveBits) notPermitted("derive-bits");
    if (length === undefined) {
      if (!state.hasNaturalLength) {
        errOther(
          "a KDF's output length is a caller choice: it has no natural output length, which only agreement sources define",
        );
      }
      const secret = await platformCall("agreement derive", () =>
        subtle.deriveBits(state.params, state.key, null as unknown as number));
      return new Uint8Array(secret);
    }
    if (length === 0 || length % 8 !== 0) {
      errOther(`derive length must be a non-zero multiple of 8 bits, got ${length}`);
    }
    const bits = await platformCall("KDF derive", () => subtle.deriveBits(state.params, state.key, length));
    return new Uint8Array(bits);
  }
}

/** The internal state a `deriveKeyFrom` target consumes (params + platform key + policy). */
export function inputStateOf(i: DeriveInput): DeriveInputState {
  return inputOf(i);
}

/**
 * Mint a platform key from a `derive-input` (a target interface's
 * `derive-key`): requires `can-derive-key`, and an extractable result
 * additionally requires `can-derive-bits` — an exportable key is bits
 * disclosure by other means (reference: js/jco/webcrypto.js
 * `deriveKeyFrom`, lines 1374-1397).
 */
export async function deriveKeyFrom(
  input: DeriveInput,
  // deno-lint-ignore no-explicit-any
  derivedParams: any,
  extractable: boolean,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const state = inputOf(input);
  if (!state.policy.deriveKey) notPermitted("derive-key");
  if (extractable && !state.policy.deriveBits) {
    errNotPermitted(
      "minting an extractable key requires the derive-bits grant: an exportable key is bits disclosure by other means",
    );
  }
  return await platformCall("KDF derive-key", () =>
    subtle.deriveKey(state.params, state.key, derivedParams, extractable, usages));
}

/** The `polymorph:webcrypto/derivation@0.1.0` interface: its resource classes. */
export const derivation = { DeriveOptions, DeriveInput };
