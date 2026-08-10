// Host-side EC public-key admission for the `ecdh` and `ecdsa-*`
// families: the checks the WIT pins that Deno's `crypto.subtle` does not
// perform itself.
//
// Two gaps were measured against the consumer's conformance suites under
// Deno (see the mission report):
//
//  1. Deno admits EC public keys whose point is NOT on the declared curve
//     (the Wycheproof `InvalidCurveAttack` family, e.g.
//     ecdh_secp256r1_ecpoint_test.json tcId 332-340, all `result:
//     "invalid"`). Accepting such a point is the invalid-curve attack
//     precondition: a scalar multiplication on a weaker curve leaks the
//     private scalar modulo small factors. Node rejects them, the WIT
//     requires rejection ("points not on the declared variant's curve fail
//     with `error.invalid-key`"), so this module verifies the curve
//     equation itself.
//  2. Deno ignores a JWK's `crv` member when it disagrees with the
//     requested curve (the suite's `probe/ecdh-key-contract` and
//     `probe/ecdh-format-roundtrips` cases), so `crv` — and, for ECDSA,
//     the curve-determined `alg` — are checked here.
//
// Both checks are pure predicates over PUBLIC data and strictly monotone:
// they only add rejections in front of the engine, never admit anything
// the engine would refuse. The arithmetic is `BigInt` modular arithmetic
// over the published NIST curve parameters (FIPS 186-4 D.1.2); no secret
// input passes through it.

import { errInvalidKey } from "./errors.ts";
import { b64urlDecode, requireStrictBase64url } from "./platform.ts";

interface CurveParams {
  /** The field prime. */
  p: bigint;
  /** The curve's `b` coefficient (`a` is `-3` for both served curves). */
  b: bigint;
  /** The coordinate width in bytes. */
  coordBytes: number;
}

const CURVES: Readonly<Record<string, CurveParams | undefined>> = Object.freeze({
  "P-256": {
    p: 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n,
    b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
    coordBytes: 32,
  },
  "P-384": {
    p: 2n ** 384n - 2n ** 128n - 2n ** 96n + 2n ** 32n - 1n,
    b: 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
    coordBytes: 48,
  },
});

function beToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Whether `(x, y)` satisfies `y² = x³ − 3x + b (mod p)` with both coordinates in the field. */
function isOnCurve(curve: CurveParams, x: bigint, y: bigint): boolean {
  const { p, b } = curve;
  if (x < 0n || x >= p || y < 0n || y >= p) return false;
  const lhs = (y * y) % p;
  const rhs = (((x * x % p) * x) % p - 3n * x % p + b) % p;
  return lhs === ((rhs % p) + p) % p;
}

/** Reject an uncompressed SEC1 point (`04 ‖ x ‖ y`) that is not on `namedCurve`. */
export function requireOnCurveSec1(namedCurve: string, point: Uint8Array): void {
  const curve = CURVES[namedCurve];
  if (curve === undefined) return; // an unserved curve never reaches an import
  const expected = 1 + 2 * curve.coordBytes;
  if (point.length !== expected || point[0] !== 0x04) {
    errInvalidKey(`${namedCurve} public keys are uncompressed SEC1 points (${expected} bytes, leading 0x04)`);
  }
  const x = beToBigInt(point.subarray(1, 1 + curve.coordBytes));
  const y = beToBigInt(point.subarray(1 + curve.coordBytes));
  if (!isOnCurve(curve, x, y)) {
    errInvalidKey(`${namedCurve} public key is not a point on the declared curve`);
  }
}

/**
 * Reject a SubjectPublicKeyInfo whose embedded point is not on
 * `namedCurve`. The AlgorithmIdentifier was already pinned to the
 * named-curve OID form (`requireNamedCurveSpki`), and in that form the
 * subjectPublicKey BIT STRING's contents are exactly the SEC1 point, so
 * the point is the DER's trailing `1 + 2·coordBytes` bytes. An input whose
 * tail does not have that shape is left to the platform's full DER
 * validation (this guard only ever adds rejections).
 */
export function requireOnCurveSpki(namedCurve: string, spki: Uint8Array): void {
  const curve = CURVES[namedCurve];
  if (curve === undefined) return;
  const uncompressed = 1 + 2 * curve.coordBytes;
  if (spki.length >= uncompressed) {
    const point = spki.subarray(spki.length - uncompressed);
    if (point[0] === 0x04) {
      requireOnCurveSec1(namedCurve, point);
      return;
    }
  }
  // A COMPRESSED encoding. The WIT leaves acceptance implementation-
  // defined ("do not rely on either behavior"), and engines split: Node
  // refuses, Deno decompresses — including, as the Wycheproof
  // `CompressedPoint`/`WrongCurve` cases show (ecdh_secp256r1_test.json
  // tcId 384-390), onto low-order points of the curve's twist, which is
  // the invalid-curve precondition again. This port takes the
  // conservative branch of the latitude and refuses compressed SPKI
  // points outright.
  const compressed = 1 + curve.coordBytes;
  if (spki.length >= compressed) {
    const prefix = spki[spki.length - compressed];
    if (prefix === 0x02 || prefix === 0x03) {
      errInvalidKey(`${namedCurve} SPKI carries a compressed point, which this implementation does not admit`);
    }
  }
}

/** Reject an EC JWK whose `crv` disagrees with the declared variant's curve, or whose point is off-curve. */
export function requireEcJwkCurve(namedCurve: string, jwk: Record<string, unknown>): void {
  if (jwk.crv !== namedCurve) {
    errInvalidKey(`EC JWK declares crv ${String(jwk.crv)}; the requested curve is ${namedCurve}`);
  }
  const curve = CURVES[namedCurve];
  if (curve === undefined) return;
  const { x, y } = jwk;
  if (typeof x !== "string" || typeof y !== "string") return; // the platform reports the shape error
  requireStrictBase64url(x);
  requireStrictBase64url(y);
  const xb = b64urlDecode(x);
  const yb = b64urlDecode(y);
  if (xb.length !== curve.coordBytes || yb.length !== curve.coordBytes) {
    errInvalidKey(`EC JWK coordinates must be ${curve.coordBytes} bytes for ${namedCurve}`);
  }
  if (!isOnCurve(curve, beToBigInt(xb), beToBigInt(yb))) {
    errInvalidKey(`EC JWK is not a point on ${namedCurve}`);
  }
}

/** The curve-determined JOSE signature alg an ECDSA JWK's `alg` must name exactly, when present. */
const ECDSA_JOSE_ALG: Readonly<Record<string, string>> = Object.freeze({
  "P-256": "ES256",
  "P-384": "ES384",
});

/** Reject an ECDSA JWK whose `alg` is not the curve's JOSE alg (case-exact — the WIT pins the spelling). */
export function requireEcdsaJwkAlg(namedCurve: string, jwk: Record<string, unknown>): void {
  const alg = jwk.alg;
  if (alg === undefined) return;
  const expected = ECDSA_JOSE_ALG[namedCurve];
  if (expected !== undefined && alg !== expected) {
    errInvalidKey(`EC JWK declares alg ${String(alg)}; ${namedCurve} signature keys use ${expected}`);
  }
}
