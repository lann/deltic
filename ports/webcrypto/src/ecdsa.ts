// `polymorph:webcrypto/ecdsa-verify` + `ecdsa-sign` — wit/ecdsa.wit. The
// resources are `signature`'s; this module supplies the variant table and
// the minting paths.
//
// Behavioral reference: js/jco/webcrypto.js:3970-4035 (the variant table),
// 4696-4930 (the minting paths). Signatures are P1363 (`r ‖ s`), whose
// fixed width `VerifyingKey.verify` enforces from the record below.

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
  requireSigningGrant,
  type SignatureAlgorithm,
  SigningKey,
  type SigningKeyOptions,
  signingPolicyOf,
  VerifyingKey,
} from "./signature.ts";
import { requireEcdsaJwkAlg, requireEcJwkCurve, requireOnCurveSec1, requireOnCurveSpki } from "./ec.ts";
import { consumeUnwrapInput, type UnwrapInput } from "./wrapping.ts";
import { unwrappedJwk } from "./util.ts";

const subtle = globalThis.crypto.subtle;

/** The served `ecdsa-variant` entries (reference: webcrypto.js:3975). `p521-sha512` is declared and unserved. */
const ECDSA_VARIANTS: Readonly<Record<string, SignatureAlgorithm | undefined>> = Object.freeze({
  "p256-sha256": p(256, "SHA-256"),
  "p256-sha384": p(256, "SHA-384"),
  "p256-sha512": p(256, "SHA-512"),
  "p384-sha256": p(384, "SHA-256"),
  "p384-sha384": p(384, "SHA-384"),
  "p384-sha512": p(384, "SHA-512"),
});

function p(curveBits: 256 | 384, hash: string): SignatureAlgorithm {
  const scalarLength = curveBits === 256 ? 32 : 48;
  return Object.freeze({
    name: "ECDSA",
    namedCurve: `P-${curveBits}`,
    hash,
    publicLength: scalarLength * 2 + 1,
    signatureLength: scalarLength * 2,
  });
}

function ecdsaVariant(variant: string): SignatureAlgorithm {
  return served(ECDSA_VARIANTS, variant);
}

/** The `polymorph:webcrypto/ecdsa-verify@0.1.0` interface. */
export const ecdsaVerify = {
  importVerifyingKeyRaw: async (variant: string, raw: Uint8Array): Promise<VerifyingKey> => {
    const entry = ecdsaVariant(variant);
    if (raw.length !== entry.publicLength || raw[0] !== 0x04) {
      errInvalidKey(
        `${variant} public keys are uncompressed SEC1 points (${entry.publicLength} bytes, leading 0x04)`,
      );
    }
    requireOnCurveSec1(entry.namedCurve as string, raw);
    const key = await importPlatformKey(
      `${variant} public key`,
      "raw",
      raw,
      { name: "ECDSA", namedCurve: entry.namedCurve },
      true,
      ["verify"],
    );
    return new VerifyingKey(key, entry);
  },

  importVerifyingKeySpki: async (variant: string, spki: Uint8Array): Promise<VerifyingKey> => {
    const entry = ecdsaVariant(variant);
    requireNamedCurveSpki(entry.namedCurve as string, spki);
    requireOnCurveSpki(entry.namedCurve as string, spki);
    const key = await importPlatformKey(
      `${variant} spki`,
      "spki",
      spki,
      { name: "ECDSA", namedCurve: entry.namedCurve },
      true,
      ["verify"],
    );
    return new VerifyingKey(key, entry);
  },

  importVerifyingKeyJwk: async (variant: string, jwkText: string): Promise<VerifyingKey> => {
    const entry = ecdsaVariant(variant);
    const jwk = jwkMaterial(jwkText);
    requireEcJwkCurve(entry.namedCurve as string, jwk);
    requireEcdsaJwkAlg(entry.namedCurve as string, jwk);
    const key = await importPlatformKeyJwk(
      `${variant} public JWK`,
      jwk,
      { name: "ECDSA", namedCurve: entry.namedCurve },
      true,
      ["verify"],
    );
    return new VerifyingKey(key, entry);
  },
};

/** The `polymorph:webcrypto/ecdsa-sign@0.1.0` interface. */
export const ecdsaSign = {
  generateKey: async (variant: string, options: SigningKeyOptions): Promise<[SigningKey, VerifyingKey]> => {
    const policy = signingPolicyOf(options);
    requireSigningGrant(policy);
    const entry = ecdsaVariant(variant);
    const pair = await platformCall(`${variant} key generation`, () =>
      subtle.generateKey(
        { name: "ECDSA", namedCurve: entry.namedCurve as string },
        policy.extractable,
        ["sign", "verify"],
      )) as CryptoKeyPair;
    return [new SigningKey(pair.privateKey, entry), new VerifyingKey(pair.publicKey, entry)];
  },

  importSigningKeyPkcs8: async (
    variant: string,
    pkcs8: Uint8Array,
    options: SigningKeyOptions,
  ): Promise<SigningKey> => {
    const policy = signingPolicyOf(options);
    requireSigningGrant(policy);
    const entry = ecdsaVariant(variant);
    const key = await importPlatformKey(
      `${variant} pkcs8`,
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: entry.namedCurve },
      policy.extractable,
      ["sign"],
    );
    return new SigningKey(key, entry);
  },

  importSigningKeyJwk: async (variant: string, jwkText: string, options: SigningKeyOptions): Promise<SigningKey> => {
    const policy = signingPolicyOf(options);
    requireSigningGrant(policy);
    const entry = ecdsaVariant(variant);
    const jwk = jwkMaterial(jwkText);
    requireEcJwkCurve(entry.namedCurve as string, jwk);
    requireEcdsaJwkAlg(entry.namedCurve as string, jwk);
    requireStrictBase64url(jwk.d);
    const key = await importPlatformKeyJwk(
      `${variant} private JWK`,
      jwk,
      { name: "ECDSA", namedCurve: entry.namedCurve },
      policy.extractable,
      ["sign"],
    );
    if (key.type !== "private") errInvalidKey("EC private JWK must carry `d` (base64url private scalar)");
    return new SigningKey(key, entry);
  },

  unwrapSigningKeyPkcs8: (variant: string, input: UnwrapInput, options: SigningKeyOptions): Promise<SigningKey> => {
    const { bytes } = consumeUnwrapInput(input);
    return redactingInvalidKey(
      `unwrapped ${variant} pkcs8`,
      () => ecdsaSign.importSigningKeyPkcs8(variant, bytes, options),
    );
  },

  unwrapSigningKeyJwk: (variant: string, input: UnwrapInput, options: SigningKeyOptions): Promise<SigningKey> => {
    const { bytes } = consumeUnwrapInput(input);
    requireSigningGrant(signingPolicyOf(options));
    const jwk = unwrappedJwk(bytes, "sig", ["sign"]);
    return redactingInvalidKey(
      `unwrapped ${variant} private JWK`,
      () => ecdsaSign.importSigningKeyJwk(variant, jwk, options),
    );
  },
};
