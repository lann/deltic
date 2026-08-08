// Runtime handshake (PLAN.md §9): verify a loaded plan's world against the
// digest embedded by generated bindgen code, producing a rich mismatch
// report that names the first divergent import/export/type path rather
// than just "digests differ".

import type { WirePlan } from "../plan/format.ts";
import { computeWorldDigest } from "./digest.ts";

export interface DigestMismatch {
  expected: string;
  actual: string;
  /** Human-readable description of the first structural divergence found,
   * or `null` if a divergence exists but no finer-grained cause could be
   * isolated (e.g. the two canonical JSON trees have the same top-level
   * shape but the digest still differs — should not happen in practice
   * since the digest is a pure hash of that JSON, but guarded anyway). */
  firstDivergence: string | null;
}

/**
 * Verify `plan`'s computed world digest against `expectedDigest` (the
 * constant bindgen embedded at generation time). Returns `null` on match,
 * or a `DigestMismatch` report naming the first divergent path on
 * mismatch.
 */
export async function verifyWorldDigest(
  plan: WirePlan,
  expectedDigest: string,
): Promise<DigestMismatch | null> {
  const actual = await computeWorldDigest(plan);
  if (actual.digest === expectedDigest) return null;
  return {
    expected: expectedDigest,
    actual: actual.digest,
    firstDivergence: null, // filled in by compareAgainstExpectedJson if available
  };
}

/**
 * `diffWorldDigest` — richer variant for tests/tooling: compare against
 * another plan's (or a WIT-derived) canonical JSON directly, walking both
 * trees in parallel to name the first divergent import/export/type path.
 * `expectedCanonicalJson` is normally produced by `crates/bindgen`'s
 * `digest --json` output, or by `computeWorldDigest` on a reference plan.
 */
export async function diffWorldDigest(
  plan: WirePlan,
  expectedCanonicalJson: string,
): Promise<DigestMismatch | null> {
  const actual = await computeWorldDigest(plan);
  const expected = JSON.parse(expectedCanonicalJson);
  const expectedDigestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(expectedCanonicalJson),
  );
  const expectedDigest = "sha256:" +
    Array.from(new Uint8Array(expectedDigestBytes)).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
  if (actual.digest === expectedDigest) return null;
  const actualParsed = JSON.parse(actual.canonicalJson);
  return {
    expected: expectedDigest,
    actual: actual.digest,
    firstDivergence: firstDivergentPath(expected, actualParsed, "$"),
  };
}

/**
 * Walk two canonical world trees in parallel (both already sorted by name
 * at every `imports`/`exports`/`items` level — see digest.ts), returning a
 * human-readable path to the first field that differs, or `null` if the
 * trees are structurally identical (shouldn't happen if the digests
 * differ, but the digest is a hash — collisions or caller error are
 * possible, so this is a defensive `null`, not a promise of "same").
 */
function firstDivergentPath(
  expected: unknown,
  actual: unknown,
  path: string,
): string | null {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}: length ${expected.length} (expected) vs ${actual.length} (actual)`;
    }
    for (let i = 0; i < expected.length; i++) {
      const label = itemLabel(expected[i]) ?? `[${i}]`;
      const d = firstDivergentPath(expected[i], actual[i], `${path}.${label}`);
      if (d) return d;
    }
    return null;
  }
  if (
    expected !== null && actual !== null &&
    typeof expected === "object" && typeof actual === "object" &&
    !Array.isArray(expected) && !Array.isArray(actual)
  ) {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    for (const k of [...keys].sort()) {
      if (!(k in a)) return `${path}.${k}: present (expected) but missing (actual)`;
      if (!(k in e)) return `${path}.${k}: missing (expected) but present (actual)`;
      const d = firstDivergentPath(e[k], a[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (expected !== actual) {
    return `${path}: ${JSON.stringify(expected)} (expected) vs ${
      JSON.stringify(actual)
    } (actual)`;
  }
  return null;
}

function itemLabel(v: unknown): string | undefined {
  if (v !== null && typeof v === "object" && "name" in v) {
    const name = (v as Record<string, unknown>).name;
    if (typeof name === "string") return JSON.stringify(name);
  }
  return undefined;
}
