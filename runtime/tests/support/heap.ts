// Test heap: behavioral twin of run_tests.py::Heap (bump allocator over a
// fixed buffer; shrinking realloc returns the aligned original pointer).
// The string-lowering fixtures in tests/fixtures/strings.json are generated
// against exactly this allocator — keep in lockstep with
// tests/fixtures/generate.py::Heap.

import { alignTo, trapIf } from "../../src/cabi/mod.ts";
import type { ReallocFn } from "../../src/cabi/mod.ts";

export class Heap {
  memory: Uint8Array;
  lastAlloc = 0;
  numReallocCalls = 0;

  constructor(sizeOrBytes: number | Uint8Array) {
    this.memory = typeof sizeOrBytes === "number"
      ? new Uint8Array(sizeOrBytes)
      : sizeOrBytes;
  }

  realloc: ReallocFn = (originalPtr, originalSize, alignment, newSize) => {
    this.numReallocCalls += 1;
    if (originalPtr !== 0 && newSize < originalSize) {
      return alignTo(originalPtr, alignment);
    }
    const ret = alignTo(this.lastAlloc, alignment);
    this.lastAlloc = ret + newSize;
    trapIf(this.lastAlloc > this.memory.length, "mock heap exhausted");
    this.memory.copyWithin(ret, originalPtr, originalPtr + originalSize);
    return ret;
  };
}
