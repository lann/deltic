// Lifting and lowering of full value lists with spilling (definitions.py
// `## Lifting and Lowering Values`): parameter/result sequences that exceed
// the flat maximum are passed indirectly through a tuple in linear memory.

import { trapIf } from "./trap.ts";
import { alignment, alignTo, elemSize } from "./layout.ts";
import { load } from "./load.ts";
import { store } from "./store.ts";
import { type CoreValueIter, liftFlat, type ValueIter } from "./lift.ts";
import { lowerFlat } from "./lower.ts";
import { flattenTypes } from "./flatten.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { asIndex } from "./memory.ts";
import type { ComponentValue, CoreValue, TupleType, ValType } from "./types.ts";

export function liftFlatValues(
  cx: LiftLowerContext,
  maxFlat: number,
  vi: CoreValueIter,
  ts: ValType[],
): ComponentValue[] {
  const flatTypes = flattenTypes(ts, cx.opts);
  if (flatTypes.length > maxFlat) {
    const mem = requireMemory(cx.opts);
    const ptrRaw = vi.next(mem.ptrType());
    const tupleType: TupleType = { kind: "tuple", elements: ts };
    const align = alignment(tupleType, mem.ptrType());
    const size = elemSize(tupleType, mem.ptrType());
    trapIf(BigInt(ptrRaw) % BigInt(align) !== 0n, "misaligned spill pointer");
    trapIf(
      BigInt(ptrRaw) + BigInt(size) > BigInt(mem.length),
      "spill tuple out of bounds",
    );
    const ptr = asIndex(ptrRaw);
    const tuple = load(cx, ptr, tupleType) as Record<string, ComponentValue>;
    return Object.values(tuple);
  } else {
    return ts.map((t) => liftFlat(cx, vi, t));
  }
}

export function lowerFlatValues(
  cx: LiftLowerContext,
  maxFlat: number,
  vs: ComponentValue[],
  ts: ValType[],
  outParam: ValueIter | null = null,
): CoreValue[] {
  const flatTypes = flattenTypes(ts, cx.opts);
  if (flatTypes.length > maxFlat) {
    const mem = requireMemory(cx.opts);
    const tupleType: TupleType = { kind: "tuple", elements: ts };
    const tupleValue: Record<string, ComponentValue> = {};
    vs.forEach((v, i) => {
      tupleValue[String(i)] = v;
    });
    let ptr: number;
    let flatVals: CoreValue[];
    const align = alignment(tupleType, mem.ptrType());
    const size = elemSize(tupleType, mem.ptrType());
    if (outParam === null) {
      ptr = cx.allocate(align, size);
      flatVals = mem.ptrType() === "i32" ? [ptr] : [BigInt(ptr)];
    } else {
      ptr = asIndex(outParam.next(mem.ptrType()));
      flatVals = [];
    }
    trapIf(ptr !== alignTo(ptr, align), "misaligned spill pointer");
    trapIf(ptr + size > mem.length, "spill tuple out of bounds");
    store(cx, tupleValue, tupleType, ptr);
    return flatVals;
  } else {
    const flatVals: CoreValue[] = [];
    for (let i = 0; i < vs.length; i++) {
      flatVals.push(...lowerFlat(cx, vs[i], ts[i]));
    }
    return flatVals;
  }
}
