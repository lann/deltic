// Unit tests: `polymorph:webcrypto/signature` + `ed25519-verify`/`ed25519-sign`
// (the iroh identity path's primitive — mission context).
//
// KAT source: conformance/vectors/ed25519_test.json (Wycheproof-format
// group 0: empty-message signature under the group's public key).

import { assertEq, assertRejects } from "./asserts.ts";
import { ed25519Sign, ed25519Verify, SigningKeyOptions } from "../src/mod.ts";
import { arrayStream } from "./testStream.ts";
import { WitError } from "../../../runtime/src/embedder/errors.ts";

const VECTORS_DIR = "/home/lmartin/p/polymorph/polymorph-webcrypto/conformance/vectors";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

Deno.test("ed25519: generate-key -> sign -> verify roundtrip", async () => {
  const opts = new SigningKeyOptions();
  opts.canSign(true);
  const [sk, vk] = await ed25519Sign.generateKey(opts);
  const sig = await sk.sign(arrayStream(new TextEncoder().encode("iroh identity payload")));
  await vk.verify(arrayStream(new TextEncoder().encode("iroh identity payload")), sig);
  assertEq(vk.algorithmName(), "Ed25519");
  assertEq(vk.algorithmCurve(), undefined);
  assertEq(vk.algorithmHash(), undefined);
});

Deno.test("ed25519: KAT against conformance/vectors/ed25519_test.json group 0 tcId 1", async () => {
  let raw: string;
  try {
    raw = await Deno.readTextFile(`${VECTORS_DIR}/ed25519_test.json`);
  } catch {
    console.log("  (skip: polymorph-webcrypto vectors tree not present)");
    return;
  }
  const doc = JSON.parse(raw);
  const group = doc.testGroups[0];
  const tc = group.tests.find((t: { tcId: number }) => t.tcId === 1);
  const vk = await ed25519Verify.importVerifyingKeyRaw(hexToBytes(group.publicKey.pk));
  await vk.verify(arrayStream(hexToBytes(tc.msg)), hexToBytes(tc.sig));
});

Deno.test("ed25519: verify with a tampered signature fails error.authentication-failed", async () => {
  const opts = new SigningKeyOptions();
  opts.canSign(true);
  const [sk, vk] = await ed25519Sign.generateKey(opts);
  const sig = await sk.sign(arrayStream(new TextEncoder().encode("payload")));
  sig[0] ^= 0xff; // deliberately-corrupted signature (synthetic, not real key material)
  const err = await assertRejects(
    () => vk.verify(arrayStream(new TextEncoder().encode("payload")), sig),
  ) as WitError;
  assertEq((err.payload as { tag: string }).tag, "authentication-failed");
});

Deno.test("ed25519: import-verifying-key-raw with wrong length fails error.invalid-key", async () => {
  const err = await assertRejects(
    () => ed25519Verify.importVerifyingKeyRaw(new Uint8Array(16)),
  ) as WitError;
  assertEq((err.payload as { tag: string }).tag, "invalid-key");
});

Deno.test("ed25519: sign without can-sign fails error.not-permitted (a untouched options resource cannot mint)", async () => {
  const opts = new SigningKeyOptions(); // canSign never called
  const err = await assertRejects(() => ed25519Sign.generateKey(opts)) as WitError;
  assertEq((err.payload as { tag: string }).tag, "not-permitted");
});
