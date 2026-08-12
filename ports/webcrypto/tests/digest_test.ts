// Unit tests: `polymorph:webcrypto/digest` + `sha2`.
//
// Known-answer digest: NIST FIPS 180-4 example message "abc" (the standard
// SHA-2 KAT every implementation cites); SHA-256 hash cited by its FIPS
// 180-4 test-vector name, not reproduced as a literal blob here beyond the
// standard published digest.

import { assertEq, assertRejects, assertThrows } from "./asserts.ts";
import { sha2 } from "../src/mod.ts";
import { arrayStream } from "./testStream.ts";
import { ComponentException } from "../../../runtime/src/embedder/errors.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("sha2: makeDigest(sha256).compute('abc') matches FIPS 180-4 KAT", async () => {
  const d = sha2.makeDigest("sha256");
  const out = await d.compute(arrayStream(new TextEncoder().encode("abc")));
  assertEq(
    hex(out),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEq(d.algorithmName(), "SHA-256");
});

Deno.test("sha2: makeDigest(sha384/sha512) compute over empty stream", async () => {
  for (const [variant, hashLen] of [["sha384", 48], ["sha512", 64]] as const) {
    const d = sha2.makeDigest(variant);
    const out = await d.compute(arrayStream(new Uint8Array(0)));
    assertEq(out.length, hashLen);
  }
});

Deno.test("sha2: sha224/sha512-224/sha512-256 decline with error.unsupported (WIT-mandated, not a Deno gap)", () => {
  for (const variant of ["sha224", "sha512-224", "sha512-256"]) {
    const err = assertThrows(() => sha2.makeDigest(variant)) as ComponentException;
    assertEq((err.payload as { kind: string }).kind, "unsupported");
  }
});

