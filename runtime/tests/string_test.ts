// String encoding tests.
//
// Fixture-driven (tests/fixtures/strings.json, generated from
// definitions.py): byte-exact lift and lower expectations for the full
// utf8/utf16/latin1+utf16 matrix on i32 and i64 memories, including realloc
// traffic against the run_tests.py Heap model. Plus TS-authored cases for
// JS-specific semantics: USVString lone-surrogate replacement (PLAN.md §7)
// and invalid-encoding traps.

import stringsFixture from "./fixtures/strings.json" with { type: "json" };
import {
  loadStringFromRange,
  MemInst,
  type PtrType,
  storeStringIntoRange,
  type StringEncoding,
  utf16TagBig,
} from "../src/cabi/mod.ts";
import {
  bytesToHex,
  hexToBytes,
  mkCx,
  ptrLane,
  runTest,
  stringFromCodePoints,
} from "./support/driver.ts";
import { Heap } from "./support/heap.ts";
import { assertEq, assertTrap } from "./support/asserts.ts";

type LiftEntry = {
  srcEncoding: string;
  addrType: string;
  bytesHex: string;
  taggedCodeUnits: string;
};
type LowerEntry = {
  dstEncoding: string;
  addrType: string;
  heapSize: number;
  ptr: number;
  taggedCodeUnits: string;
  bytesHex: string;
  lastAlloc: number;
  reallocCalls: number;
};

Deno.test("string lift matches definitions.py byte-for-byte (fixtures)", () => {
  for (const entry of stringsFixture.entries) {
    const s = stringFromCodePoints(entry.codePoints);
    for (const lift of entry.lifts as LiftEntry[]) {
      const cx = mkCx(
        new MemInst(hexToBytes(lift.bytesHex), lift.addrType as PtrType),
        lift.srcEncoding as StringEncoding,
      );
      const got = loadStringFromRange(cx, 0, BigInt(lift.taggedCodeUnits));
      assertEq(
        got,
        s,
        `lift ${JSON.stringify(s)} from ${lift.srcEncoding}/${lift.addrType}`,
      );
    }
  }
});

Deno.test("string lower matches definitions.py byte-for-byte (fixtures)", () => {
  for (const entry of stringsFixture.entries) {
    const s = stringFromCodePoints(entry.codePoints);
    for (const lower of entry.lowers as LowerEntry[]) {
      const name = `lower ${
        JSON.stringify(s)
      } to ${lower.dstEncoding}/${lower.addrType}`;
      const heap = new Heap(lower.heapSize);
      const cx = mkCx(
        new MemInst(heap.memory, lower.addrType as PtrType),
        lower.dstEncoding as StringEncoding,
        heap.realloc,
      );
      const [ptr, tagged] = storeStringIntoRange(cx, s);
      assertEq(ptr, lower.ptr, `${name}: ptr`);
      assertEq(tagged, BigInt(lower.taggedCodeUnits), `${name}: tagged units`);
      const tag = utf16TagBig(lower.addrType as PtrType);
      let byteLen: bigint;
      switch (lower.dstEncoding) {
        case "utf8":
          byteLen = tagged;
          break;
        case "utf16":
          byteLen = 2n * tagged;
          break;
        default:
          byteLen = (tagged & tag) !== 0n ? 2n * (tagged ^ tag) : tagged;
      }
      assertEq(
        bytesToHex(heap.memory.subarray(ptr, ptr + Number(byteLen))),
        lower.bytesHex,
        `${name}: bytes`,
      );
      assertEq(heap.lastAlloc, lower.lastAlloc, `${name}: last_alloc`);
      assertEq(
        heap.numReallocCalls,
        lower.reallocCalls,
        `${name}: realloc calls`,
      );
    }
  }
});

Deno.test("string lift/lower roundtrips across the encoding matrix", () => {
  for (const entry of stringsFixture.entries) {
    const s = stringFromCodePoints(entry.codePoints);
    for (const lift of entry.lifts as LiftEntry[]) {
      const at = lift.addrType as PtrType;
      for (const dst of ["utf8", "utf16", "latin1+utf16"] as const) {
        const cx = mkCx(
          new MemInst(hexToBytes(lift.bytesHex), at),
          lift.srcEncoding as StringEncoding,
        );
        const units = BigInt(lift.taggedCodeUnits);
        runTest(
          { kind: "string" },
          [ptrLane(0, at), at === "i64" ? units : Number(units)],
          s,
          cx,
          dst,
        );
      }
    }
  }
});

Deno.test("USVString semantics: lone surrogates lower as U+FFFD (PLAN.md §7)", () => {
  const lone = "a\ud800b"; // unpaired high surrogate
  const replaced = "a\ufffdb";

  // utf8 destination
  {
    const heap = new Heap(64);
    const cx = mkCx(new MemInst(heap.memory, "i32"), "utf8", heap.realloc);
    const [ptr, tagged] = storeStringIntoRange(cx, lone);
    const expected = new TextEncoder().encode(replaced);
    assertEq(tagged, BigInt(expected.length));
    assertEq(
      bytesToHex(heap.memory.subarray(ptr, ptr + expected.length)),
      bytesToHex(expected),
    );
    const cx2 = mkCx(new MemInst(heap.memory, "i32"), "utf8");
    assertEq(loadStringFromRange(cx2, ptr, tagged), replaced);
  }

  // utf16 destination
  {
    const heap = new Heap(64);
    const cx = mkCx(new MemInst(heap.memory, "i32"), "utf16", heap.realloc);
    const [ptr, tagged] = storeStringIntoRange(cx, lone);
    assertEq(tagged, 3n);
    const cx2 = mkCx(new MemInst(heap.memory, "i32"), "utf16");
    assertEq(loadStringFromRange(cx2, ptr, tagged), replaced);
  }

  // latin1+utf16 destination: U+FFFD forces the utf16 (tagged) form
  {
    const heap = new Heap(64);
    const cx = mkCx(
      new MemInst(heap.memory, "i32"),
      "latin1+utf16",
      heap.realloc,
    );
    const [ptr, tagged] = storeStringIntoRange(cx, lone);
    assertEq(tagged & utf16TagBig("i32"), utf16TagBig("i32"));
    const cx2 = mkCx(new MemInst(heap.memory, "i32"), "latin1+utf16");
    assertEq(loadStringFromRange(cx2, ptr, tagged), replaced);
  }

  // well-formed surrogate pairs are preserved
  {
    const emoji = "x\u{1f600}y";
    const heap = new Heap(64);
    const cx = mkCx(new MemInst(heap.memory, "i32"), "utf8", heap.realloc);
    const [ptr, tagged] = storeStringIntoRange(cx, emoji);
    const cx2 = mkCx(new MemInst(heap.memory, "i32"), "utf8");
    assertEq(loadStringFromRange(cx2, ptr, tagged), emoji);
  }
});

Deno.test("string lift traps on invalid encodings and bounds", () => {
  // invalid utf8
  assertTrap(() => {
    const cx = mkCx(new MemInst(Uint8Array.from([0xff]), "i32"), "utf8");
    return loadStringFromRange(cx, 0, 1);
  }, "invalid utf8 byte");
  // CESU-8 encoded surrogate is not valid utf8
  assertTrap(() => {
    const cx = mkCx(
      new MemInst(Uint8Array.from([0xed, 0xa0, 0x80]), "i32"),
      "utf8",
    );
    return loadStringFromRange(cx, 0, 3);
  }, "utf8-encoded surrogate");
  // lone surrogate in guest utf16 traps on lift (strict decode)
  assertTrap(() => {
    const cx = mkCx(new MemInst(Uint8Array.from([0x00, 0xd8]), "i32"), "utf16");
    return loadStringFromRange(cx, 0, 1);
  }, "lone surrogate utf16");
  // out of bounds
  assertTrap(() => {
    const cx = mkCx(new MemInst(Uint8Array.from([0x61]), "i32"), "utf8");
    return loadStringFromRange(cx, 0, 2);
  }, "OOB length");
  // misaligned utf16 pointer
  assertTrap(() => {
    const cx = mkCx(
      new MemInst(Uint8Array.from([0, 0x61, 0]), "i32"),
      "utf16",
    );
    return loadStringFromRange(cx, 1, 1);
  }, "misaligned utf16 ptr");
  // string byte length above MAX_STRING_BYTE_LENGTH
  assertTrap(() => {
    const cx = mkCx(new MemInst(new Uint8Array(0), "i64"), "utf8");
    return loadStringFromRange(cx, 0, 1n << 60n);
  }, "giant length");
});
