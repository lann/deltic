// Unit tests: `polymorph:webcrypto/hkdf` + `hkdf-sha2` (RFC 5869).
//
// KAT source: conformance/vectors/hkdf_sha256_test.json tcId 1 — RFC 5869
// Appendix A.1 Test Case 1 (the construction's own reference vector).

import { assertEq, assertRejects } from "./asserts.ts";
import { DeriveOptions, hkdf, hkdfSha2 } from "../src/mod.ts";
import { ComponentException } from "../../../runtime/src/embedder/errors.ts";

const VECTORS_DIR = "/home/lmartin/p/polymorph/polymorph-webcrypto/conformance/vectors";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function deriveOptions(): DeriveOptions {
  const o = new DeriveOptions();
  o.canDeriveBits(true);
  o.canDeriveKey(true);
  return o;
}

Deno.test("hkdf-sha2: RFC 5869 Test Case 1 KAT (conformance/vectors/hkdf_sha256_test.json tcId 1)", async () => {
  let raw: string;
  try {
    raw = await Deno.readTextFile(`${VECTORS_DIR}/hkdf_sha256_test.json`);
  } catch {
    console.log("  (skip: polymorph-webcrypto vectors tree not present)");
    return;
  }
  const doc = JSON.parse(raw);
  const tc = doc.testGroups[0].tests.find((t: { tcId: number }) => t.tcId === 1);
  const ikm = await hkdf.importIkm(hexToBytes(tc.ikm), deriveOptions());
  const input = await hkdfSha2.prepare("sha256", ikm, hexToBytes(tc.salt), hexToBytes(tc.info));
  const okm = await input.deriveBits(tc.size * 8);
  assertEq(hex(okm), tc.okm.toLowerCase());
});

Deno.test("hkdf: import-ikm accepts empty material (RFC 5869 permits it)", async () => {
  const ikm = await hkdf.importIkm(new Uint8Array(0), deriveOptions());
  const input = await hkdfSha2.prepare("sha256", ikm, new Uint8Array(0), new Uint8Array(0));
  const okm = await input.deriveBits(32);
  assertEq(okm.length, 4);
});

Deno.test("hkdf: import-ikm with a grantless options resource fails error.not-permitted", async () => {
  const err = await assertRejects(
    () => hkdf.importIkm(new Uint8Array(16), new DeriveOptions()),
  ) as ComponentException;
  assertEq((err.payload as { kind: string }).kind, "not-permitted");
});

Deno.test("hkdf-sha2: derive-bits(none) on a KDF input fails error.other (no natural output length)", async () => {
  const ikm = await hkdf.importIkm(new Uint8Array(16).fill(7), deriveOptions());
  const input = await hkdfSha2.prepare("sha256", ikm, new Uint8Array(0), new Uint8Array(0));
  const err = await assertRejects(() => input.deriveBits(undefined)) as ComponentException;
  assertEq((err.payload as { kind: string }).kind, "other");
});
