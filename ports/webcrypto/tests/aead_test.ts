// Unit tests: `polymorph:webcrypto/aead` + `aes-gcm` (NIST SP 800-38D).
//
// KAT source: conformance/vectors/aes_gcm_test.json (Wycheproof-format,
// group 0: 128-bit key / 96-bit IV / 128-bit tag — tcId 1).

import { assertEq, assertRejects } from "./asserts.ts";
import { AeadKeyOptions, aesGcm } from "../src/mod.ts";
import { arrayStream } from "./testStream.ts";
import { WitError } from "../../../runtime/src/embedder/errors.ts";

const VECTORS_DIR = "/home/lmartin/p/polymorph/polymorph-webcrypto/conformance/vectors";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fullOptions(): AeadKeyOptions {
  const o = new AeadKeyOptions();
  o.canSeal(true);
  o.canOpen(true);
  return o;
}

Deno.test("aes-gcm: seal/open round-trip (aes256)", async () => {
  const key = await aesGcm.generateKey("aes256", fullOptions());
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode("associated data");
  const plaintext = new TextEncoder().encode("iroh handshake payload");
  const sealed = await key.seal(nonce, aad, undefined, arrayStream(plaintext));
  assertEq(sealed.length, plaintext.length + 16); // default 16-byte tag
  const opened = await key.open(nonce, aad, undefined, arrayStream(sealed));
  assertEq(hex(opened), hex(plaintext));
  assertEq(key.algorithmName(), "AES-GCM");
  assertEq(key.nonceSize(), 12);
  assertEq(key.tagSize(), 16);
});

Deno.test("aes-gcm: KAT against conformance/vectors/aes_gcm_test.json group 0 tcId 1 (128-bit key)", async () => {
  let raw: string;
  try {
    raw = await Deno.readTextFile(`${VECTORS_DIR}/aes_gcm_test.json`);
  } catch {
    console.log("  (skip: polymorph-webcrypto vectors tree not present)");
    return;
  }
  const doc = JSON.parse(raw);
  const tc = doc.testGroups[0].tests.find((t: { tcId: number }) => t.tcId === 1);
  const key = await aesGcm.importKeyRaw("aes128", hexToBytes(tc.key), fullOptions());
  const sealed = await key.seal(hexToBytes(tc.iv), hexToBytes(tc.aad), undefined, arrayStream(hexToBytes(tc.msg)));
  assertEq(hex(sealed), (tc.ct + tc.tag).toLowerCase());
});

Deno.test("aes-gcm: open with a tampered ciphertext fails error.authentication-failed", async () => {
  const key = await aesGcm.generateKey("aes256", fullOptions());
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await key.seal(nonce, new Uint8Array(0), undefined, arrayStream(new TextEncoder().encode("data")));
  sealed[0] ^= 0xff;
  const err = await assertRejects(
    () => key.open(nonce, new Uint8Array(0), undefined, arrayStream(sealed)),
  ) as WitError;
  assertEq((err.payload as { tag: string }).tag, "authentication-failed");
});

Deno.test("aes-gcm: seal on an open-only key fails error.not-permitted", async () => {
  const opts = new AeadKeyOptions();
  opts.canOpen(true); // seal NOT granted
  const key = await aesGcm.generateKey("aes256", opts);
  const err = await assertRejects(
    () => key.seal(new Uint8Array(12), new Uint8Array(0), undefined, arrayStream(new Uint8Array(4))),
  ) as WitError;
  assertEq((err.payload as { tag: string }).tag, "not-permitted");
});

Deno.test("aes-gcm: seal with an out-of-window nonce fails error.invalid-nonce", async () => {
  const key = await aesGcm.generateKey("aes256", fullOptions());
  const err = await assertRejects(
    () => key.seal(new Uint8Array(4), new Uint8Array(0), undefined, arrayStream(new Uint8Array(4))),
  ) as WitError;
  assertEq((err.payload as { tag: string }).tag, "invalid-nonce");
});

Deno.test("aes-gcm: aes192 is declined with error.unsupported (WIT portability ruling, not a Deno-specific gap)", async () => {
  const err = await assertRejects(
    () => aesGcm.generateKey("aes192", fullOptions()),
  ) as WitError;
  assertEq((err.payload as { tag: string }).tag, "unsupported");
});
