// The RSA signature families: `rsassa-pkcs1-v15-verify` / `-sign` and
// `rsa-pss-verify` / `-sign` — wit/rsa.wit. The resources are
// `signature`'s; this module supplies the shared admission rules and the
// minting paths.
//
// Behavioral reference: js/jco/webcrypto.js:4930-5365.
//
// Two admission facts the platform does not enforce and the WIT does
// (reference: webcrypto.js:4932, checked on the IMPORTED key's metadata,
// so no DER or JWK parsing is needed): the modulus length must lie in the
// caller's window, and the public exponent must be odd and at least 3.

import { errInvalidKey, errUnsupported, platformCall } from "./errors.ts";
import {
  importPlatformKey,
  importPlatformKeyJwk,
  jwkMaterial,
  redactingInvalidKey,
  requireRsaEncryptionSpki,
  requireStrictBase64url,
  served,
  SHA2_VARIANTS,
} from "./platform.ts";
import {
  requireSigningGrant,
  type SignatureAlgorithm,
  SigningKey,
  type SigningKeyOptions,
  signingPolicyOf,
  VerifyingKey,
} from "./signature.ts";
import { consumeUnwrapInput, type UnwrapInput } from "./wrapping.ts";
import { unwrappedJwk } from "./util.ts";

const subtle = globalThis.crypto.subtle;

/** The `rsa-variant` table: RSA's parameterization is the digest alone (SHA-1 is deliberately absent). */
export const RSA_VARIANTS = SHA2_VARIANTS;

/** The family's admission window, in bits (reference: webcrypto.js:4877). */
const RSA_MODULUS_MIN_BITS = 1024;
const RSA_MODULUS_MAX_BITS = 16384;
/** The signing interfaces' tightened window (reference: webcrypto.js:4881). */
export const RSA_SIGNING_MIN_BITS = 2048;
export const RSA_SIGNING_MAX_BITS = 8192;

/** The generated modulus length per `rsa-modulus` case (reference: webcrypto.js:4888). */
export const RSA_MODULUS_BITS: Readonly<Record<string, number | undefined>> = Object.freeze({
  m2048: 2048,
  m3072: 3072,
  m4096: 4096,
  m8192: 8192,
});

/** The admission checks the platform omits, run on the imported key's metadata (reference: webcrypto.js:4932). */
export function rsaAdmittedModulusLength(
  key: CryptoKey,
  what: string,
  minBits: number = RSA_MODULUS_MIN_BITS,
  maxBits: number = RSA_MODULUS_MAX_BITS,
): number {
  const { modulusLength, publicExponent } = key.algorithm as RsaHashedKeyAlgorithm;
  if (modulusLength < minBits || modulusLength > maxBits) {
    errInvalidKey(`invalid ${what}: RSA modulus must be ${minBits}-${maxBits} bits, got ${modulusLength}`);
  }
  // `publicExponent` is the big-endian magnitude; leading zeros only make
  // the octet count larger, never the value.
  let first = 0;
  while (first < publicExponent.length && publicExponent[first] === 0) first++;
  const octets = publicExponent.length - first;
  const low = octets === 0 ? 0 : publicExponent[publicExponent.length - 1];
  if ((low & 1) === 0 || (octets === 1 && low < 3)) {
    errInvalidKey(`invalid ${what}: RSA public exponent must be odd and at least 3`);
  }
  return modulusLength;
}

/** The mint-bound record for an admitted RSA key (reference: webcrypto.js:4966). */
export function rsaAlgorithm(
  name: string,
  hash: string,
  modulusLength: number,
  saltLength: number | undefined,
): SignatureAlgorithm {
  return {
    name,
    namedCurve: undefined,
    hash,
    length: modulusLength,
    signatureLength: Math.ceil(modulusLength / 8),
    saltLength,
  };
}

/** RSA-PSS signing fixes the salt length to the digest length (the JOSE `PS*` profile; reference: webcrypto.js:5128). */
function rsaSigningAlgorithm(
  name: string,
  entry: { hash: string; digestBytes: number },
  modulusLength: number,
): SignatureAlgorithm {
  return rsaAlgorithm(name, entry.hash, modulusLength, name === "RSA-PSS" ? entry.digestBytes : undefined);
}

/**
 * The RSA private-key posture (reference: webcrypto.js:5091-5127). The
 * reference declines RSA private-key minting outside Node, because those
 * operations leak key material through execution timing unless the
 * implementation is constant-time end to end, and a browser is the
 * archetypal attacker-observable timing domain.
 *
 * CONTRACT: this port runs under Deno — a server runtime whose co-tenancy
 * the deployer chooses, like Node — so the default here is `"serve"`, the
 * reference's Node posture. A browser-hosted embedding of this port should
 * call `setRsaPrivateKeyPolicy("decline")`; the decline then surfaces as
 * `error.unsupported` and the consumer declares the gated features
 * missing on that target.
 */
let rsaPrivateKeyPolicy: "serve" | "decline" = "serve";

export function setRsaPrivateKeyPolicy(policy: "serve" | "decline"): void {
  rsaPrivateKeyPolicy = policy;
}

export function requireRsaPrivateKeysServed(): void {
  if (rsaPrivateKeyPolicy !== "serve") {
    errUnsupported("RSA private-key operations are declined in this environment; see setRsaPrivateKeyPolicy");
  }
}

async function importRsaVerifyingKeySpki(
  name: string,
  variant: string,
  spki: Uint8Array,
  saltLength: number | undefined,
): Promise<VerifyingKey> {
  const { hash } = served(RSA_VARIANTS, variant);
  requireRsaEncryptionSpki(spki);
  const key = await importPlatformKey(`${name} spki`, "spki", spki, { name, hash }, true, ["verify"]);
  const modulusLength = rsaAdmittedModulusLength(key, `${name} spki`);
  return new VerifyingKey(key, rsaAlgorithm(name, hash, modulusLength, saltLength));
}

/**
 * The JOSE `alg` an RSA JWK must name EXACTLY, when present, for a given
 * family and variant (the WIT pins the spelling: `RS*` for
 * RSASSA-PKCS1-v1_5, `PS*` for RSA-PSS, `RSA-OAEP-*` for OAEP). Checked
 * host-side because Deno's import ignores a mismatched — and even a
 * wrong-CASE — `alg` where Node refuses it.
 */
export function requireRsaJwkAlg(prefix: string, variant: string, jwk: Record<string, unknown>): void {
  const alg = jwk.alg;
  if (alg === undefined) return;
  const bits = { sha256: "256", sha384: "384", sha512: "512" }[variant];
  if (bits === undefined) return;
  const expected = `${prefix}${bits}`;
  if (alg !== expected) {
    errInvalidKey(`RSA JWK declares alg ${String(alg)}; this variant uses ${expected}`);
  }
}

/** The JOSE `alg` prefix per WebCrypto algorithm name. */
export function rsaJwkAlgPrefix(name: string): string {
  return name === "RSA-PSS" ? "PS" : name === "RSA-OAEP" ? "RSA-OAEP-" : "RS";
}

async function importRsaVerifyingKeyJwk(
  name: string,
  variant: string,
  jwkText: string,
  saltLength: number | undefined,
): Promise<VerifyingKey> {
  const { hash } = served(RSA_VARIANTS, variant);
  const jwk = jwkMaterial(jwkText);
  requireRsaJwkAlg(rsaJwkAlgPrefix(name), variant, jwk);
  requireStrictBase64url(jwk.n);
  requireStrictBase64url(jwk.e);
  const key = await importPlatformKeyJwk(`${name} public JWK`, jwk, { name, hash }, true, ["verify"]);
  const modulusLength = rsaAdmittedModulusLength(key, `${name} public JWK`);
  return new VerifyingKey(key, rsaAlgorithm(name, hash, modulusLength, saltLength));
}

/** The `polymorph:webcrypto/rsassa-pkcs1-v15-verify@0.1.0` interface. */
export const rsassaPkcs1V15Verify = {
  importVerifyingKeySpki: (variant: string, spki: Uint8Array): Promise<VerifyingKey> =>
    importRsaVerifyingKeySpki("RSASSA-PKCS1-v1_5", variant, spki, undefined),
  importVerifyingKeyJwk: (variant: string, jwk: string): Promise<VerifyingKey> =>
    importRsaVerifyingKeyJwk("RSASSA-PKCS1-v1_5", variant, jwk, undefined),
};

/** The `polymorph:webcrypto/rsa-pss-verify@0.1.0` interface. */
export const rsaPssVerify = {
  importVerifyingKeySpki: (variant: string, saltLength: number, spki: Uint8Array): Promise<VerifyingKey> =>
    importRsaVerifyingKeySpki("RSA-PSS", variant, spki, saltLength),
  importVerifyingKeyJwk: (variant: string, saltLength: number, jwk: string): Promise<VerifyingKey> =>
    importRsaVerifyingKeyJwk("RSA-PSS", variant, jwk, saltLength),
};

async function generateRsaSigningKey(
  name: string,
  variant: string,
  modulus: string,
  options: SigningKeyOptions,
): Promise<[SigningKey, VerifyingKey]> {
  requireRsaPrivateKeysServed();
  const policy = signingPolicyOf(options);
  requireSigningGrant(policy);
  const entry = served(RSA_VARIANTS, variant);
  const modulusLength = served(RSA_MODULUS_BITS, modulus);
  const pair = await platformCall(`${name} key generation`, () =>
    subtle.generateKey(
      { name, hash: entry.hash, modulusLength, publicExponent: new Uint8Array([1, 0, 1]) },
      policy.extractable,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  const algorithm = rsaSigningAlgorithm(name, entry, modulusLength);
  return [new SigningKey(pair.privateKey, algorithm), new VerifyingKey(pair.publicKey, algorithm)];
}

async function importRsaSigningKeyPkcs8(
  name: string,
  variant: string,
  pkcs8: Uint8Array,
  options: SigningKeyOptions,
): Promise<SigningKey> {
  requireRsaPrivateKeysServed();
  const policy = signingPolicyOf(options);
  requireSigningGrant(policy);
  const entry = served(RSA_VARIANTS, variant);
  const key = await importPlatformKey(
    `${name} pkcs8`,
    "pkcs8",
    pkcs8,
    { name, hash: entry.hash },
    policy.extractable,
    ["sign"],
  );
  const modulusLength = rsaAdmittedModulusLength(key, `${name} pkcs8`, RSA_SIGNING_MIN_BITS, RSA_SIGNING_MAX_BITS);
  return new SigningKey(key, rsaSigningAlgorithm(name, entry, modulusLength));
}

async function importRsaSigningKeyJwk(
  name: string,
  variant: string,
  jwkText: string,
  options: SigningKeyOptions,
): Promise<SigningKey> {
  requireRsaPrivateKeysServed();
  const policy = signingPolicyOf(options);
  requireSigningGrant(policy);
  const entry = served(RSA_VARIANTS, variant);
  const jwk = jwkMaterial(jwkText);
  requireRsaJwkAlg(rsaJwkAlgPrefix(name), variant, jwk);
  for (const member of ["n", "e", "d", "p", "q", "dp", "dq", "qi"]) {
    requireStrictBase64url(jwk[member]);
  }
  const key = await importPlatformKeyJwk(
    `${name} private JWK`,
    jwk,
    { name, hash: entry.hash },
    policy.extractable,
    ["sign"],
  );
  if (key.type !== "private") errInvalidKey("RSA private JWK must carry `d` and the CRT members");
  const modulusLength = rsaAdmittedModulusLength(
    key,
    `${name} private JWK`,
    RSA_SIGNING_MIN_BITS,
    RSA_SIGNING_MAX_BITS,
  );
  return new SigningKey(key, rsaSigningAlgorithm(name, entry, modulusLength));
}

function rsaSigningInterface(name: "RSASSA-PKCS1-v1_5" | "RSA-PSS") {
  return {
    generateKey: (variant: string, modulus: string, options: SigningKeyOptions) =>
      generateRsaSigningKey(name, variant, modulus, options),
    importSigningKeyPkcs8: (variant: string, pkcs8: Uint8Array, options: SigningKeyOptions) =>
      importRsaSigningKeyPkcs8(name, variant, pkcs8, options),
    importSigningKeyJwk: (variant: string, jwk: string, options: SigningKeyOptions) =>
      importRsaSigningKeyJwk(name, variant, jwk, options),
    unwrapSigningKeyPkcs8: (variant: string, input: UnwrapInput, options: SigningKeyOptions) => {
      const { bytes } = consumeUnwrapInput(input);
      return redactingInvalidKey(
        `unwrapped ${name} pkcs8`,
        () => importRsaSigningKeyPkcs8(name, variant, bytes, options),
      );
    },
    unwrapSigningKeyJwk: (variant: string, input: UnwrapInput, options: SigningKeyOptions) => {
      const { bytes } = consumeUnwrapInput(input);
      requireSigningGrant(signingPolicyOf(options));
      const jwk = unwrappedJwk(bytes, "sig", ["sign"]);
      return redactingInvalidKey(
        `unwrapped ${name} private JWK`,
        () => importRsaSigningKeyJwk(name, variant, jwk, options),
      );
    },
  };
}

/** The `polymorph:webcrypto/rsassa-pkcs1-v15-sign@0.1.0` interface. */
export const rsassaPkcs1V15Sign = rsaSigningInterface("RSASSA-PKCS1-v1_5");

/** The `polymorph:webcrypto/rsa-pss-sign@0.1.0` interface. */
export const rsaPssSign = rsaSigningInterface("RSA-PSS");
