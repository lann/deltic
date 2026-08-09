// Unit tests: `polymorph:webcrypto/key-agreement` + `x25519` (RFC 7748) —
// the shape wasi-shims's `webcryptoFixture()` test-local glue hand-rolled
// (wasi-shims/tests/integration_exec_model_test.ts:66-86); this is the real
// port's coverage of the same family plus `agree`/`derive-bits`.

import { assertEq, assertRejects } from "./asserts.ts";
import { AgreementKeyOptions, x25519 } from "../src/mod.ts";
import { WitError } from "../../../runtime/src/embedder/errors.ts";

function agreeOptions(): AgreementKeyOptions {
  const o = new AgreementKeyOptions();
  o.canDeriveBits(true);
  o.canDeriveKey(true);
  return o;
}

Deno.test("x25519: generate-key -> export-key-raw round-trips a 32-byte u-coordinate", async () => {
  const [, pub] = await x25519.generateKey(agreeOptions());
  const raw = await pub.exportKeyRaw();
  assertEq(raw.length, 32);
  assertEq(pub.algorithmName(), "X25519");
});

Deno.test("key-agreement: agree() + derive-bits(none) yields the natural 32-byte shared secret, symmetric both ways", async () => {
  const [skA, pubA] = await x25519.generateKey(agreeOptions());
  const [skB, pubB] = await x25519.generateKey(agreeOptions());
  const inputA = skA.agree(pubB);
  const inputB = skB.agree(pubA);
  const secretA = await inputA.deriveBits(undefined);
  const secretB = await inputB.deriveBits(undefined);
  assertEq(secretA.length, 32);
  assertEq([...secretA].join(","), [...secretB].join(","));
});

Deno.test("key-agreement: derive-bits(length) yields exactly `length` bits", async () => {
  const [skA, pubA] = await x25519.generateKey(agreeOptions());
  const [, pubB] = await x25519.generateKey(agreeOptions());
  const input = skA.agree(pubB);
  const bits = await input.deriveBits(128);
  assertEq(bits.length, 16);
  void pubA;
});

Deno.test("key-agreement: derive-bits without can-derive-bits fails error.not-permitted", async () => {
  const opts = new AgreementKeyOptions();
  opts.canDeriveKey(true); // deriveBits NOT granted
  const [sk] = await x25519.generateKey(opts);
  const [, pub2] = await x25519.generateKey(agreeOptions());
  const input = sk.agree(pub2);
  const err = await assertRejects(() => input.deriveBits(undefined)) as WitError;
  assertEq((err.payload as { tag: string }).tag, "not-permitted");
});

Deno.test("x25519: import-public-key-raw with wrong length fails error.invalid-key", async () => {
  const err = await assertRejects(() => x25519.importPublicKeyRaw(new Uint8Array(10))) as WitError;
  assertEq((err.payload as { tag: string }).tag, "invalid-key");
});
