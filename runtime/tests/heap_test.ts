// Port of run_tests.py `test_heap` cases: lifting lists (and lists of
// compounds) out of a prepared linear memory, then the driver's
// lower/re-lift roundtrip. Byte images are copied verbatim from
// run_tests.py.

import { type CoreValue, MemInst, type ValType } from "../src/cabi/mod.ts";
import type { ComponentValue, PtrType } from "../src/cabi/mod.ts";
import { EXPECT_TRAP, mkCx, mkTup, runTest } from "./support/driver.ts";

const u8: ValType = { kind: "u8" };
const u16: ValType = { kind: "u16" };
const u32: ValType = { kind: "u32" };
const u64: ValType = { kind: "u64" };

function testHeap(
  t: ValType,
  expect: ComponentValue | typeof EXPECT_TRAP,
  args: CoreValue[],
  byteArray: number[],
  addrType: PtrType = "i32",
) {
  const memory = Uint8Array.from(byteArray);
  const cx = mkCx(new MemInst(memory, addrType));
  runTest(t, args, expect, cx);
}

const list = (element: ValType, length?: number): ValType =>
  length === undefined
    ? { kind: "list", element }
    : { kind: "list", element, length };

Deno.test("list<bool> from heap", () => {
  testHeap(list({ kind: "bool" }), [true, false, true], [0, 3], [1, 0, 1]);
  testHeap(list({ kind: "bool" }), [true, false, true], [0, 3], [1, 0, 2]);
  testHeap(
    list({ kind: "bool" }),
    [true, false, true],
    [3, 3],
    [0xff, 0xff, 0xff, 1, 0, 1],
  );
});

Deno.test("integer lists from heap", () => {
  testHeap(list(u8), Uint8Array.from([1, 2, 3]), [0, 3], [1, 2, 3]);
  testHeap(list(u16), [1, 2, 3], [0, 3], [1, 0, 2, 0, 3, 0]);
  // misaligned pointer traps
  testHeap(list(u16), EXPECT_TRAP, [1, 3], [0, 1, 0, 2, 0, 3, 0]);
  testHeap(
    list(u32),
    [1, 2, 3],
    [0, 3],
    [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0],
  );
  testHeap(
    list(u64),
    [1n, 2n],
    [0, 2],
    [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0],
  );
  testHeap(list({ kind: "s8" }), [-1, -2, -3], [0, 3], [0xff, 0xfe, 0xfd]);
  testHeap(
    list({ kind: "s16" }),
    [-1, -2, -3],
    [0, 3],
    [0xff, 0xff, 0xfe, 0xff, 0xfd, 0xff],
  );
  testHeap(
    list({ kind: "s32" }),
    [-1, -2, -3],
    [0, 3],
    // deno-fmt-ignore
    [0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xfd, 0xff, 0xff, 0xff],
  );
  testHeap(
    list({ kind: "s64" }),
    [-1n, -2n],
    [0, 2],
    // deno-fmt-ignore
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  );
});

Deno.test("list<char> from heap", () => {
  testHeap(
    list({ kind: "char" }),
    ["A", "B", "c"],
    [0, 3],
    // deno-fmt-ignore
    [65, 0, 0, 0, 66, 0, 0, 0, 99, 0, 0, 0],
  );
});

Deno.test("list<string> from heap (i32 and i64 memories)", () => {
  const h = "h".charCodeAt(0), i = "i".charCodeAt(0);
  const w = "w".charCodeAt(0), a = "a".charCodeAt(0), tt = "t".charCodeAt(0);
  testHeap(
    list({ kind: "string" }),
    ["hi", "wat"],
    [0, 2],
    // deno-fmt-ignore
    [16, 0, 0, 0, 2, 0, 0, 0, 21, 0, 0, 0, 3, 0, 0, 0,
     h, i, 0xf, 0xf, 0xf, w, a, tt],
  );
  testHeap(
    list({ kind: "string" }),
    ["hi", "wat"],
    [0n, 2n],
    // deno-fmt-ignore
    [32, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0,
     37, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0,
     h, i, 0xf, 0xf, 0xf, w, a, tt],
    "i64",
  );
});

Deno.test("list<list<...>> from heap (i32 and i64 memories)", () => {
  testHeap(
    list(list(u8)),
    [Uint8Array.from([3, 4, 5]), Uint8Array.from([]), Uint8Array.from([6, 7])],
    [0, 3],
    // deno-fmt-ignore
    [24, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 27, 0, 0, 0, 2, 0, 0, 0,
     3, 4, 5, 6, 7],
  );
  testHeap(
    list(list(u8)),
    [Uint8Array.from([3, 4, 5]), Uint8Array.from([]), Uint8Array.from([6, 7])],
    [0n, 3n],
    // deno-fmt-ignore
    [48, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     51, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0,
     3, 4, 5, 6, 7],
    "i64",
  );
  testHeap(
    list(list(u16)),
    [[5, 6]],
    [0, 1],
    // deno-fmt-ignore
    [8, 0, 0, 0, 2, 0, 0, 0, 5, 0, 6, 0],
  );
  testHeap(
    list(list(u16)),
    [[5, 6]],
    [0n, 1n],
    // deno-fmt-ignore
    [16, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 5, 0, 6, 0],
    "i64",
  );
  // inner pointer misaligned -> trap
  testHeap(
    list(list(u16)),
    EXPECT_TRAP,
    [0, 1],
    // deno-fmt-ignore
    [9, 0, 0, 0, 2, 0, 0, 0, 0, 5, 0, 6, 0],
  );
  testHeap(
    list(list(u16)),
    EXPECT_TRAP,
    [0n, 1n],
    // deno-fmt-ignore
    [17, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 6, 0],
    "i64",
  );
});

Deno.test("lists of fixed-length lists from heap", () => {
  testHeap(
    list(list(u8, 2)),
    [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])],
    [0, 2],
    [1, 2, 3, 4],
  );
  testHeap(
    list(list(u32, 2)),
    [[1, 2], [3, 4]],
    [0, 2],
    // deno-fmt-ignore
    [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0],
  );
  // misaligned -> trap
  testHeap(
    list(list(u32, 2)),
    EXPECT_TRAP,
    [1, 2],
    // deno-fmt-ignore
    [0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0],
  );
});

Deno.test("lists of tuples from heap (alignment padding)", () => {
  testHeap(
    list({ kind: "tuple", elements: [u8, u8, u16, u32] }),
    [mkTup(6, 7, 8, 9), mkTup(4, 5, 6, 7)],
    [0, 2],
    // deno-fmt-ignore
    [6, 7, 8, 0, 9, 0, 0, 0, 4, 5, 6, 0, 7, 0, 0, 0],
  );
  testHeap(
    list({ kind: "tuple", elements: [u8, u16, u8, u32] }),
    [mkTup(6, 7, 8, 9), mkTup(4, 5, 6, 7)],
    [0, 2],
    // deno-fmt-ignore
    [6, 0xff, 7, 0, 8, 0xff, 0xff, 0xff, 9, 0, 0, 0,
     4, 0xff, 5, 0, 6, 0xff, 0xff, 0xff, 7, 0, 0, 0],
  );
  testHeap(
    list({ kind: "tuple", elements: [u16, u8] }),
    [mkTup(6, 7), mkTup(8, 9)],
    [0, 2],
    [6, 0, 7, 0xff, 8, 0, 9, 0xff],
  );
  testHeap(
    list({
      kind: "tuple",
      elements: [{ kind: "tuple", elements: [u16, u8] }, u8],
    }),
    [mkTup([4, 5], 6), mkTup([7, 8], 9)],
    [0, 2],
    [4, 0, 5, 0xff, 6, 0xff, 7, 0, 8, 0xff, 9, 0xff],
  );
});

Deno.test("lists of flags from heap", () => {
  const flags2: ValType = { kind: "flags", labels: ["a", "b"] };
  testHeap(
    list(flags2),
    [{ a: false, b: false }, { a: false, b: true }, { a: true, b: true }],
    [0, 3],
    [0, 2, 3],
  );
  // out-of-range bits are dropped
  testHeap(
    list(flags2),
    [{ a: false, b: false }, { a: false, b: true }, { a: false, b: false }],
    [0, 3],
    [0, 2, 4],
  );

  const mkAll = (n: number, b: boolean) => {
    const o: Record<string, boolean> = {};
    for (let i = 0; i < n; i++) o[String(i)] = b;
    return o;
  };
  const flagsN = (n: number): ValType => ({
    kind: "flags",
    labels: Array.from({ length: n }, (_, i) => String(i)),
  });

  testHeap(
    list(flagsN(9)),
    [mkAll(9, true), mkAll(9, false)],
    [0, 2],
    [0xff, 0x1, 0, 0],
  );
  testHeap(
    list(flagsN(9)),
    [mkAll(9, true), mkAll(9, false)],
    [0, 2],
    [0xff, 0x3, 0, 0],
  );
  testHeap(
    list(flagsN(17)),
    [mkAll(17, true), mkAll(17, false)],
    [0, 2],
    [0xff, 0xff, 0x1, 0, 0, 0, 0, 0],
  );
  testHeap(
    list(flagsN(17)),
    [mkAll(17, true), mkAll(17, false)],
    [0, 2],
    [0xff, 0xff, 0x3, 0, 0, 0, 0, 0],
  );
  testHeap(
    list(flagsN(32)),
    [mkAll(32, true), mkAll(32, false)],
    [0, 2],
    [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0],
  );
});

Deno.test("map from heap (despecializes to list<tuple<k,v>>)", () => {
  testHeap(
    { kind: "map", key: u8, value: u16 },
    [{ "0": 42, "1": 83 }, { "0": 43, "1": 84 }],
    [0, 2],
    [42, 0xff, 83, 0, 43, 0xff, 84, 0],
  );
});
