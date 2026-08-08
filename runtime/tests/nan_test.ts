// Port of run_tests.py test_nan32/test_nan64: NaN canonicalization on flat
// lift and on load from memory (deterministic profile — the only profile
// this JS port implements; see runtime/README.md).

import {
  CANONICAL_FLOAT32_NAN,
  CANONICAL_FLOAT64_NAN,
  CoreValueIter,
  decodeI32AsFloat,
  decodeI64AsFloat,
  encodeFloatAsI32,
  encodeFloatAsI64,
  liftFlat,
  load,
  MemInst,
} from "../src/cabi/mod.ts";
import { mkCx } from "./support/driver.ts";
import { assertEq } from "./support/asserts.ts";

function testNan32(inbits: number, outbits: number) {
  const origf = decodeI32AsFloat(inbits);
  const f = liftFlat(mkCx(), new CoreValueIter([origf]), { kind: "f32" });
  assertEq(
    encodeFloatAsI32(f as number),
    outbits,
    `nan32 lift 0x${inbits.toString(16)}`,
  );

  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, inbits, true);
  const cx = mkCx(new MemInst(bytes, "i32"));
  const f2 = load(cx, 0, { kind: "f32" });
  assertEq(
    encodeFloatAsI32(f2 as number),
    outbits,
    `nan32 load 0x${inbits.toString(16)}`,
  );
}

function testNan64(inbits: bigint, outbits: bigint) {
  const origf = decodeI64AsFloat(inbits);
  const f = liftFlat(mkCx(), new CoreValueIter([origf]), { kind: "f64" });
  assertEq(
    encodeFloatAsI64(f as number),
    outbits,
    `nan64 lift 0x${inbits.toString(16)}`,
  );

  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, inbits, true);
  const cx = mkCx(new MemInst(bytes, "i32"));
  const f2 = load(cx, 0, { kind: "f64" });
  assertEq(
    encodeFloatAsI64(f2 as number),
    outbits,
    `nan64 load 0x${inbits.toString(16)}`,
  );
}

Deno.test("nan32 canonicalization", () => {
  testNan32(0x7fc00000, CANONICAL_FLOAT32_NAN);
  testNan32(0x7fc00001, CANONICAL_FLOAT32_NAN);
  testNan32(0x7fe00000, CANONICAL_FLOAT32_NAN);
  testNan32(0x7fffffff, CANONICAL_FLOAT32_NAN);
  testNan32(0xffffffff, CANONICAL_FLOAT32_NAN);
  testNan32(0x7f800000, 0x7f800000); // +inf passes through
  testNan32(0x3fc00000, 0x3fc00000); // 1.5 passes through
});

Deno.test("nan64 canonicalization", () => {
  testNan64(0x7ff8000000000000n, CANONICAL_FLOAT64_NAN);
  testNan64(0x7ff8000000000001n, CANONICAL_FLOAT64_NAN);
  testNan64(0x7ffc000000000000n, CANONICAL_FLOAT64_NAN);
  testNan64(0x7fffffffffffffffn, CANONICAL_FLOAT64_NAN);
  testNan64(0xffffffffffffffffn, CANONICAL_FLOAT64_NAN);
  testNan64(0x7ff0000000000000n, 0x7ff0000000000000n); // +inf
  testNan64(0x3ff0000000000000n, 0x3ff0000000000000n); // 1.0
});
