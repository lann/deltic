// Unit tests: `polymorph:webcrypto/mac` + `hmac-sha2`/`hmac-sha1`.
//
// KAT source: conformance/vectors/hmac_sha256_test.json (Wycheproof-format;
// tcId 1, "empty message" — read by path, not reproduced as a literal blob
// here beyond what the test needs).

import { assertEq, assertRejects } from "./asserts.ts";
import { hmacSha1, hmacSha2, MacKeyOptions } from "../src/mod.ts";
import { arrayStream } from "./testStream.ts";
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

function signOptions(): MacKeyOptions {
  const o = new MacKeyOptions();
  o.canSign(true);
  o.canVerify(true);
  return o;
}

Deno.test("hmac-sha2: sign/verify roundtrip over sha256", async () => {
  const key = await hmacSha2.importKeyRaw("sha256", new Uint8Array(32).fill(0x11), signOptions());
  const tag = await key.sign(arrayStream(new TextEncoder().encode("hello")));
  await key.verify(arrayStream(new TextEncoder().encode("hello")), tag);
  assertEq(key.algorithmName(), "HMAC");
  assertEq(key.algorithmHash(), "SHA-256");
});

Deno.test("hmac-sha2: KAT against conformance/vectors/hmac_sha256_test.json tcId 1", async () => {
  let raw: string;
  try {
    raw = await Deno.readTextFile(`${VECTORS_DIR}/hmac_sha256_test.json`);
  } catch {
    console.log("  (skip: polymorph-webcrypto vectors tree not present)");
    return;
  }
  const doc = JSON.parse(raw);
  const tc = doc.testGroups[0].tests.find((t: { tcId: number }) => t.tcId === 1);
  const key = await hmacSha2.importKeyRaw("sha256", hexToBytes(tc.key), signOptions());
  const tag = await key.sign(arrayStream(hexToBytes(tc.msg)));
  assertEq(hex(tag), tc.tag.toLowerCase());
});

Deno.test("hmac-sha1: sign/verify roundtrip", async () => {
  const key = await hmacSha1.importKeyRaw(new Uint8Array(20).fill(0x22), signOptions());
  const tag = await key.sign(arrayStream(new TextEncoder().encode("msg")));
  await key.verify(arrayStream(new TextEncoder().encode("msg")), tag);
});

Deno.test("mac: sign on a verify-only key fails error.not-permitted (the usage-grant taxonomy case)", async () => {
  const opts = new MacKeyOptions();
  opts.canVerify(true); // sign NOT granted
  const key = await hmacSha2.importKeyRaw("sha256", new Uint8Array(32).fill(0x33), opts);
  const err = await assertRejects(() => key.sign(arrayStream(new Uint8Array(0)))) as ComponentException;
  assertEq((err.payload as { kind: string; value: string }).kind, "not-permitted");
});

Deno.test("mac: verify with a wrong tag fails error.authentication-failed", async () => {
  const key = await hmacSha2.importKeyRaw("sha256", new Uint8Array(32).fill(0x44), signOptions());
  const wrongTag = new Uint8Array(32); // all-zero: not the real tag
  const err = await assertRejects(
    () => key.verify(arrayStream(new TextEncoder().encode("data")), wrongTag),
  ) as ComponentException;
  assertEq((err.payload as { kind: string }).kind, "authentication-failed");
});

Deno.test("mac: importKeyRaw with empty material fails error.invalid-key", async () => {
  const err = await assertRejects(
    () => hmacSha2.importKeyRaw("sha256", new Uint8Array(0), signOptions()),
  ) as ComponentException;
  assertEq((err.payload as { kind: string }).kind, "invalid-key");
});

Deno.test("mac: export-key-raw on a non-extractable key fails error.not-extractable", async () => {
  const opts = new MacKeyOptions();
  opts.canSign(true);
  // extractable NOT granted (default false, per the package-wide options contract)
  const key = await hmacSha2.importKeyRaw("sha256", new Uint8Array(32).fill(0x55), opts);
  const err = await assertRejects(() => key.exportKeyRaw()) as ComponentException;
  assertEq((err.payload as { kind: string }).kind, "not-extractable");
});
