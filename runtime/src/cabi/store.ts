// Storing component values into linear memory (definitions.py `## Storing`).

import { assert_, NotImplemented, trapIf } from "./trap.ts";
import { storeInt, storePtr } from "./memory.ts";
import { encodeFloatAsI32, encodeFloatAsI64 } from "./float.ts";
import {
  alignment,
  alignTo,
  elemSize,
  elemSizeFlags,
  maxCaseAlignment,
} from "./layout.ts";
import { charToI32, REALLOC_I32_MAX, storeString } from "./strings.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { lowerBorrow, lowerOwn } from "./handles.ts";
import {
  type CaseType,
  type ComponentValue,
  despecialize,
  discriminantType,
  type FieldType,
  type ValType,
} from "./types.ts";

export function store(
  cx: LiftLowerContext,
  v: ComponentValue,
  t: ValType,
  ptr: number,
): void {
  const mem = requireMemory(cx.opts);
  assert_(
    ptr === alignTo(ptr, alignment(t, mem.ptrType())),
    "store misaligned",
  );
  assert_(ptr + elemSize(t, mem.ptrType()) <= mem.length, "store OOB");
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      storeInt(mem, Number(Boolean(v)), ptr, 1);
      return;
    case "u8":
      storeInt(mem, v as number, ptr, 1);
      return;
    case "u16":
      storeInt(mem, v as number, ptr, 2);
      return;
    case "u32":
      storeInt(mem, v as number, ptr, 4);
      return;
    case "u64":
      storeInt(mem, v as bigint, ptr, 8);
      return;
    case "s8":
      storeInt(mem, v as number, ptr, 1, true);
      return;
    case "s16":
      storeInt(mem, v as number, ptr, 2, true);
      return;
    case "s32":
      storeInt(mem, v as number, ptr, 4, true);
      return;
    case "s64":
      storeInt(mem, v as bigint, ptr, 8, true);
      return;
    case "f32":
      storeInt(mem, encodeFloatAsI32(v as number), ptr, 4);
      return;
    case "f64":
      storeInt(mem, encodeFloatAsI64(v as number), ptr, 8);
      return;
    case "char":
      storeInt(mem, charToI32(v as string), ptr, 4);
      return;
    case "string":
      storeString(cx, v as string, ptr);
      return;
    case "error-context":
      throw new NotImplemented("error-context lower (needs task machinery)");
    case "list":
      storeList(
        cx,
        v as ArrayLike<ComponentValue>,
        ptr,
        d.element,
        d.length ?? null,
      );
      return;
    case "record":
      storeRecord(cx, v as Record<string, ComponentValue>, ptr, d.fields);
      return;
    case "variant":
      storeVariant(cx, v as Record<string, ComponentValue>, ptr, d.cases);
      return;
    case "flags":
      storeFlags(cx, v as Record<string, ComponentValue>, ptr, d.labels);
      return;
    case "own":
      storeInt(mem, lowerOwn(cx, v as number, d), ptr, 4);
      return;
    case "borrow":
      storeInt(mem, lowerBorrow(cx, v as number, d), ptr, 4);
      return;
    case "stream":
    case "future":
      throw new NotImplemented("stream/future lower (needs copy machinery)");
  }
}

export function storeList(
  cx: LiftLowerContext,
  v: ArrayLike<ComponentValue>,
  ptr: number,
  elemType: ValType,
  maybeLength: number | null,
): void {
  if (maybeLength !== null) {
    assert_(maybeLength === v.length, "fixed-length list length mismatch");
    storeListIntoValidRange(cx, v, ptr, elemType);
    return;
  }
  const mem = requireMemory(cx.opts);
  const [begin, length] = storeListIntoRange(cx, v, elemType);
  storePtr(mem, begin, ptr);
  storePtr(mem, length, ptr + mem.ptrSize());
}

export function storeListIntoRange(
  cx: LiftLowerContext,
  v: ArrayLike<ComponentValue>,
  elemType: ValType,
): [number, number] {
  const mem = requireMemory(cx.opts);
  const byteLength = v.length * elemSize(elemType, mem.ptrType());
  assert_(byteLength <= REALLOC_I32_MAX);
  const align = alignment(elemType, mem.ptrType());
  const ptr = cx.allocate(align, byteLength);
  trapIf(ptr !== alignTo(ptr, align), "realloc result misaligned");
  trapIf(ptr + byteLength > mem.length, "list allocation out of bounds");
  storeListIntoValidRange(cx, v, ptr, elemType);
  return [ptr, v.length];
}

export function storeListIntoValidRange(
  cx: LiftLowerContext,
  v: ArrayLike<ComponentValue>,
  ptr: number,
  elemType: ValType,
): void {
  const mem = requireMemory(cx.opts);
  const size = elemSize(elemType, mem.ptrType());
  for (let i = 0; i < v.length; i++) {
    store(cx, v[i], elemType, ptr + i * size);
  }
}

export function storeRecord(
  cx: LiftLowerContext,
  v: Record<string, ComponentValue>,
  ptr: number,
  fields: FieldType[],
): void {
  const mem = requireMemory(cx.opts);
  let p = ptr;
  for (const f of fields) {
    p = alignTo(p, alignment(f.type, mem.ptrType()));
    store(cx, v[f.label], f.type, p);
    p += elemSize(f.type, mem.ptrType());
  }
}

/** definitions.py match_case: the value is a single-key object. */
export function matchCase(
  v: Record<string, ComponentValue>,
  cases: CaseType[],
): [number, ComponentValue] {
  const keys = Object.keys(v);
  assert_(keys.length === 1, "variant value must have exactly one case");
  const label = keys[0];
  const matches = cases.flatMap((c, i) => (c.label === label ? [i] : []));
  assert_(matches.length === 1, `variant case '${label}' not found`);
  return [matches[0], v[label]];
}

export function storeVariant(
  cx: LiftLowerContext,
  v: Record<string, ComponentValue>,
  ptr: number,
  cases: CaseType[],
): void {
  const mem = requireMemory(cx.opts);
  const [caseIndex, caseValue] = matchCase(v, cases);
  const discSize = elemSize(discriminantType(cases), mem.ptrType());
  storeInt(mem, caseIndex, ptr, discSize as 1 | 2 | 4);
  let p = ptr + discSize;
  p = alignTo(p, maxCaseAlignment(cases, mem.ptrType()));
  const c = cases[caseIndex];
  if (c.type !== null) {
    store(cx, caseValue, c.type, p);
  }
}

export function storeFlags(
  cx: LiftLowerContext,
  v: Record<string, ComponentValue>,
  ptr: number,
  labels: string[],
): void {
  const mem = requireMemory(cx.opts);
  const i = packFlagsIntoInt(v, labels);
  storeInt(mem, i, ptr, elemSizeFlags(labels) as 1 | 2 | 4);
}

export function packFlagsIntoInt(
  v: Record<string, ComponentValue>,
  labels: string[],
): number {
  let i = 0;
  let shift = 0;
  for (const l of labels) {
    i = (i | ((v[l] ? 1 : 0) << shift)) >>> 0;
    shift += 1;
  }
  return i;
}
