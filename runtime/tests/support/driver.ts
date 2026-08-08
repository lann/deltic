// Port of run_tests.py's generic `test()` driver plus small helpers
// (mk_opts/mk_cx/mk_tup and lane utilities).

import {
  type CanonicalOptions,
  type ComponentValue,
  type CoreValue,
  CoreValueIter,
  liftFlat,
  LiftLowerContext,
  lowerFlat,
  MemInst,
  mkCanonicalOptions,
  type PtrType,
  type ReallocFn,
  type StringEncoding,
  Trap,
  type ValType,
} from "../../src/cabi/mod.ts";
import { Heap } from "./heap.ts";
import { assertEq } from "./asserts.ts";

export const EXPECT_TRAP: unique symbol = Symbol("expect-trap");

export function mkOpts(
  memory: MemInst = new MemInst(new Uint8Array(0), "i32"),
  encoding: StringEncoding = "utf8",
  realloc: ReallocFn | null = null,
): CanonicalOptions {
  return mkCanonicalOptions({ memory, stringEncoding: encoding, realloc });
}

export function mkCx(
  memory: MemInst = new MemInst(new Uint8Array(0), "i32"),
  encoding: StringEncoding = "utf8",
  realloc: ReallocFn | null = null,
): LiftLowerContext {
  return new LiftLowerContext(mkOpts(memory, encoding, realloc));
}

/** run_tests.py mk_tup: nested arrays -> despecialized tuple records. */
export function mkTup(...a: unknown[]): ComponentValue {
  const rec = (x: unknown): ComponentValue => {
    if (Array.isArray(x)) {
      const o: { [k: string]: ComponentValue } = {};
      x.forEach((v, i) => {
        o[String(i)] = rec(v);
      });
      return o;
    }
    return x as ComponentValue;
  };
  const o: { [k: string]: ComponentValue } = {};
  a.forEach((v, i) => {
    o[String(i)] = rec(v);
  });
  return o;
}

/** Convert pointer-lane numbers to bigint lanes for i64 memories. */
export function ptrLane(v: number, ptrType: PtrType): CoreValue {
  return ptrType === "i64" ? BigInt(v) : v;
}

/**
 * Port of run_tests.py `test(t, vals_to_lift, v, cx, dst_encoding, lower_t,
 * lower_v)`: lift the flat values and compare; then lower into a fresh heap
 * (5x the source memory) and re-lift, comparing again.
 */
export function runTest(
  t: ValType,
  valsToLift: CoreValue[],
  v: ComponentValue | typeof EXPECT_TRAP,
  cx: LiftLowerContext = mkCx(),
  dstEncoding: StringEncoding | null = null,
  lowerT: ValType | null = null,
  lowerV: ComponentValue | null = null,
): void {
  const name = `test(${JSON.stringify(t)}, [${valsToLift.map(String)}])`;
  const vi = new CoreValueIter(valsToLift);

  if (v === EXPECT_TRAP) {
    let got: ComponentValue;
    try {
      got = liftFlat(cx, vi, t);
    } catch (e) {
      if (e instanceof Trap) return;
      throw e;
    }
    throw new Error(`${name}: expected trap, but got ${JSON.stringify(got)}`);
  }

  const got = liftFlat(cx, vi, t);
  if (!vi.done()) throw new Error(`${name}: flat values left over`);
  assertEq(got, v, `${name}: initial lift`);

  lowerT ??= t;
  lowerV ??= v;

  const srcMem = cx.opts.memory!;
  const heap = new Heap(5 * srcMem.length);
  const dstEnc = dstEncoding ?? cx.opts.stringEncoding;
  const cx2 = mkCx(
    new MemInst(heap.memory, srcMem.ptrType()),
    dstEnc,
    heap.realloc,
  );
  const loweredVals = lowerFlat(cx2, v, lowerT);
  const vi2 = new CoreValueIter(loweredVals);
  const reLifted = liftFlat(cx2, vi2, lowerT);
  assertEq(reLifted, lowerV, `${name}: re-lift after lower(${dstEnc})`);
}

export function runTestPairs(
  t: ValType,
  pairs: [CoreValue, ComponentValue | typeof EXPECT_TRAP][],
): void {
  for (const [arg, expect] of pairs) {
    runTest(t, [arg], expect);
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stringFromCodePoints(points: number[]): string {
  let s = "";
  for (const p of points) s += String.fromCodePoint(p);
  return s;
}
