// Tests for lift_flat_values / lower_flat_values: spilling of oversized
// parameter/result lists through a tuple in linear memory (the mechanics
// behind MAX_FLAT_PARAMS/MAX_FLAT_RESULTS in canon_lift/canon_lower).
// TS-authored against definitions.py semantics (run_tests.py only exercises
// these through the deferred canon_lift/canon_lower paths).

import {
  type ComponentValue,
  CoreValueIter,
  liftFlatValues,
  lowerFlatValues,
  MemInst,
  type PtrType,
  type ValType,
} from "../src/cabi/mod.ts";
import { mkCx, ptrLane } from "./support/driver.ts";
import { Heap } from "./support/heap.ts";
import { assertEq, assertTrap } from "./support/asserts.ts";

const u8: ValType = { kind: "u8" };
const u32: ValType = { kind: "u32" };

function cxWithHeap(size: number, at: PtrType) {
  const heap = new Heap(size);
  return { heap, cx: mkCx(new MemInst(heap.memory, at), "utf8", heap.realloc) };
}

Deno.test("17 params spill through memory (i32 and i64)", () => {
  for (const at of ["i32", "i64"] as PtrType[]) {
    const ts = Array.from({ length: 17 }, () => u8);
    const vs: ComponentValue[] = Array.from({ length: 17 }, (_, i) => i + 1);
    const { heap, cx } = cxWithHeap(64, at);

    const flat = lowerFlatValues(cx, 16, vs, ts);
    assertEq(flat.length, 1, "single spilled pointer");
    const ptr = Number(flat[0]);
    assertEq(
      [...heap.memory.subarray(ptr, ptr + 17)],
      vs,
      "tuple bytes in memory",
    );

    const lifted = liftFlatValues(cx, 16, new CoreValueIter(flat), ts);
    assertEq(lifted, vs, `roundtrip (${at})`);
  }
});

Deno.test("results beyond max_flat spill via caller-provided out pointer", () => {
  for (const at of ["i32", "i64"] as PtrType[]) {
    const ts: ValType[] = [{ kind: "tuple", elements: [u8, u32] }];
    const vs: ComponentValue[] = [{ "0": 5, "1": 0x11223344 }];
    const { heap, cx } = cxWithHeap(64, at);

    // caller passes retp = 8 (aligned for u32)
    const outParam = new CoreValueIter([ptrLane(8, at)]);
    const flat = lowerFlatValues(cx, 1, vs, ts, outParam);
    assertEq(flat, [], "no flat results when out-param is used");
    assertEq(heap.memory[8], 5);
    assertEq(
      [...heap.memory.subarray(12, 16)],
      [0x44, 0x33, 0x22, 0x11],
    );

    const lifted = liftFlatValues(
      cx,
      1,
      new CoreValueIter([ptrLane(8, at)]),
      ts,
    );
    assertEq(lifted, vs, `out-param roundtrip (${at})`);
  }
});

Deno.test("results beyond max_flat allocate via realloc when no out pointer", () => {
  const ts: ValType[] = [{ kind: "tuple", elements: [u8, u8] }];
  const vs: ComponentValue[] = [{ "0": 7, "1": 9 }];
  const { heap, cx } = cxWithHeap(64, "i32");

  const flat = lowerFlatValues(cx, 1, vs, ts);
  assertEq(flat.length, 1, "returns the allocated pointer");
  const ptr = Number(flat[0]);
  assertEq([...heap.memory.subarray(ptr, ptr + 2)], [7, 9]);
  assertEq(heap.numReallocCalls, 1);

  const lifted = liftFlatValues(cx, 1, new CoreValueIter(flat), ts);
  assertEq(lifted, vs);
});

Deno.test("spill pointer alignment and bounds traps", () => {
  const ts: ValType[] = [{ kind: "tuple", elements: [u32, u32] }];
  const { cx } = cxWithHeap(64, "i32");
  assertTrap(
    () => liftFlatValues(cx, 1, new CoreValueIter([2]), ts),
    "misaligned spill pointer",
  );
  assertTrap(
    () => liftFlatValues(cx, 1, new CoreValueIter([60]), ts),
    "spill tuple out of bounds",
  );
  const outParam = new CoreValueIter([2]);
  assertTrap(
    () => lowerFlatValues(cx, 1, [{ "0": 1, "1": 2 }], ts, outParam),
    "misaligned out-param",
  );
});

Deno.test("values below max_flat stay flat", () => {
  const cx = mkCx();
  const ts: ValType[] = [u8, { kind: "u64" }];
  const flat = lowerFlatValues(cx, 16, [3, 4n], ts);
  assertEq(flat, [3, 4n]);
  const lifted = liftFlatValues(cx, 16, new CoreValueIter(flat), ts);
  assertEq(lifted, [3, 4n]);
});
