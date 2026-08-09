// wasi:random@0.2 — shapes and lengths (contracts/embedder-api.md
// §"WASI examination"; C2 gate: "random shapes").

import { assertEq, assertTrue } from "./asserts.ts";
import { random } from "../src/random.ts";

Deno.test("random: get-random-bytes returns exactly `len` bytes", () => {
  const { imports } = random();
  const r = imports["wasi:random/random@0.2"] as {
    getRandomBytes(len: bigint): Uint8Array;
  };
  assertEq(r.getRandomBytes(16n).length, 16);
  assertEq(r.getRandomBytes(0n).length, 0);
});

Deno.test("random: get-random-u64 returns a bigint", () => {
  const { imports } = random();
  const r = imports["wasi:random/random@0.2"] as { getRandomU64(): bigint };
  assertTrue(typeof r.getRandomU64() === "bigint");
});

Deno.test("random: insecure mirrors random's shapes", () => {
  const { imports } = random();
  const insecure = imports["wasi:random/insecure@0.2"] as {
    getInsecureRandomBytes(len: bigint): Uint8Array;
    getInsecureRandomU64(): bigint;
  };
  assertEq(insecure.getInsecureRandomBytes(8n).length, 8);
  assertTrue(typeof insecure.getInsecureRandomU64() === "bigint");
});

Deno.test("random: insecure-seed defaults to a documented deterministic value", () => {
  const { imports } = random();
  const seedIface = imports["wasi:random/insecure-seed@0.2"] as {
    insecureSeed(): readonly [bigint, bigint];
  };
  const [a, b] = seedIface.insecureSeed();
  assertEq(a, 0n);
  assertEq(b, 1n);
  // Predictable across calls, as the WIT doc comment for insecure-seed
  // explicitly allows.
  const [a2, b2] = seedIface.insecureSeed();
  assertEq(a2, a);
  assertEq(b2, b);
});

Deno.test("random: insecure-seed is override-able", () => {
  const { imports } = random({ insecureSeed: [7n, 9n] });
  const seedIface = imports["wasi:random/insecure-seed@0.2"] as {
    insecureSeed(): readonly [bigint, bigint];
  };
  const [a, b] = seedIface.insecureSeed();
  assertEq(a, 7n);
  assertEq(b, 9n);
});
