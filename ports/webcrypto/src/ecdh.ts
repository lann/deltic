// `polymorph:webcrypto/ecdh` — wit/ecdh.wit. The resources are
// `key-agreement`'s (this interface only mints them), so this module is
// pure minting: the curve table, the raw/SPKI/JWK admission rules the WIT
// pins ahead of the platform, and the unwrap mints.
//
// Behavioral reference: js/jco/webcrypto.js:2060-2390.

import { errInvalidKey, platformCall } from "./errors.ts";
import {
  importPlatformKey,
  importPlatformKeyJwk,
  jwkMaterial,
  redactingInvalidKey,
  requireNamedCurveSpki,
  requireStrictBase64url,
  served,
} from "./platform.ts";
import {
  AGREEMENT_PLATFORM_USAGES,
  agreementGrantedOps,
  type AgreementKeyOptions,
  agreementPolicyOf,
  PublicKey,
  requireAgreementGrant,
  SecretKey,
} from "./keyAgreement.ts";
import { requireEcJwkCurve, requireOnCurveSec1, requireOnCurveSpki } from "./ec.ts";
import { consumeUnwrapInput, type UnwrapInput } from "./wrapping.ts";
import { unwrappedJwk } from "./util.ts";

const subtle = globalThis.crypto.subtle;

/**
 * The served `ecdh-variant` entries (reference: webcrypto.js:2064). `p521`
 * is declared by the WIT and served by no implementation of this package —
 * `served` renders the decline as `error.unsupported`.
 */
const ECDH_CURVES: Readonly<Record<string, { namedCurve: string; publicLength: number } | undefined>> = Object.freeze({
  p256: { namedCurve: "P-256", publicLength: 65 },
  p384: { namedCurve: "P-384", publicLength: 97 },
});

function ecdhCurve(variant: string): { namedCurve: string; publicLength: number } {
  return served(ECDH_CURVES, variant);
}

/** The `polymorph:webcrypto/ecdh@0.1.0` interface. */
export const ecdh = {
  /**
   * Uncompressed SEC1 only: the length and leading-`0x04` checks are
   * enforced here because engines differ on compressed-point raw imports
   * and the WIT pins their rejection (reference: webcrypto.js:2094).
   */
  importPublicKeyRaw: async (variant: string, raw: Uint8Array): Promise<PublicKey> => {
    const entry = ecdhCurve(variant);
    if (raw.length !== entry.publicLength || raw[0] !== 0x04) {
      errInvalidKey(
        `${variant} public keys are uncompressed SEC1 points (${entry.publicLength} bytes, leading 0x04)`,
      );
    }
    requireOnCurveSec1(entry.namedCurve, raw);
    const key = await importPlatformKey(
      `${variant} public key`,
      "raw",
      raw,
      { name: "ECDH", namedCurve: entry.namedCurve },
      true,
      [],
    );
    return new PublicKey(key);
  },

  importPublicKeySpki: async (variant: string, spki: Uint8Array): Promise<PublicKey> => {
    const entry = ecdhCurve(variant);
    requireNamedCurveSpki(entry.namedCurve, spki);
    requireOnCurveSpki(entry.namedCurve, spki);
    const key = await importPlatformKey(
      `${variant} spki`,
      "spki",
      spki,
      { name: "ECDH", namedCurve: entry.namedCurve },
      true,
      [],
    );
    return new PublicKey(key);
  },

  importPublicKeyJwk: async (variant: string, jwkText: string): Promise<PublicKey> => {
    const entry = ecdhCurve(variant);
    const jwk = jwkMaterial(jwkText);
    requireEcJwkCurve(entry.namedCurve, jwk);
    const key = await importPlatformKeyJwk(
      `${variant} public JWK`,
      jwk,
      { name: "ECDH", namedCurve: entry.namedCurve },
      true,
      [],
    );
    return new PublicKey(key);
  },

  importSecretKeyJwk: async (variant: string, jwkText: string, options: AgreementKeyOptions): Promise<SecretKey> => {
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const entry = ecdhCurve(variant);
    const jwk = jwkMaterial(jwkText);
    requireEcJwkCurve(entry.namedCurve, jwk);
    requireStrictBase64url(jwk.d);
    const key = await importPlatformKeyJwk(
      `${variant} private JWK`,
      jwk,
      { name: "ECDH", namedCurve: entry.namedCurve },
      policy.extractable,
      AGREEMENT_PLATFORM_USAGES,
    );
    if (key.type !== "private") {
      errInvalidKey("EC private JWK must carry `d` (base64url private scalar)");
    }
    return new SecretKey(key, policy);
  },

  importSecretKeyPkcs8: async (
    variant: string,
    pkcs8: Uint8Array,
    options: AgreementKeyOptions,
  ): Promise<SecretKey> => {
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const entry = ecdhCurve(variant);
    const key = await importPlatformKey(
      `${variant} pkcs8`,
      "pkcs8",
      pkcs8,
      { name: "ECDH", namedCurve: entry.namedCurve },
      policy.extractable,
      AGREEMENT_PLATFORM_USAGES,
    );
    return new SecretKey(key, policy);
  },

  generateKey: async (variant: string, options: AgreementKeyOptions): Promise<[SecretKey, PublicKey]> => {
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const entry = ecdhCurve(variant);
    const pair = await platformCall(`${variant} key generation`, () =>
      subtle.generateKey(
        { name: "ECDH", namedCurve: entry.namedCurve },
        policy.extractable,
        AGREEMENT_PLATFORM_USAGES,
      )) as CryptoKeyPair;
    return [new SecretKey(pair.privateKey, policy), new PublicKey(pair.publicKey)];
  },

  unwrapSecretKeyJwk: (variant: string, input: UnwrapInput, options: AgreementKeyOptions): Promise<SecretKey> => {
    const { bytes } = consumeUnwrapInput(input);
    const policy = agreementPolicyOf(options);
    requireAgreementGrant(policy);
    const jwk = unwrappedJwk(bytes, "enc", agreementGrantedOps(policy));
    return redactingInvalidKey(
      `unwrapped ${variant} private JWK`,
      () => ecdh.importSecretKeyJwk(variant, jwk, options),
    );
  },

  unwrapSecretKeyPkcs8: (variant: string, input: UnwrapInput, options: AgreementKeyOptions): Promise<SecretKey> => {
    const { bytes } = consumeUnwrapInput(input);
    return redactingInvalidKey(
      `unwrapped ${variant} pkcs8`,
      () => ecdh.importSecretKeyPkcs8(variant, bytes, options),
    );
  },
};
