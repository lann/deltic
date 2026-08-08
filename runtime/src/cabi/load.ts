// Loading component values from linear memory (definitions.py `## Loading`).

import { assert_, NotImplemented, trapIf } from "./trap.ts";
import { bytesOf, loadIntS, loadIntU, loadPtr } from "./memory.ts";
import { decodeI32AsFloat, decodeI64AsFloat } from "./float.ts";
import {
  alignment,
  alignTo,
  elemSize,
  elemSizeFlags,
  maxCaseAlignment,
} from "./layout.ts";
import { convertI32ToChar, loadString } from "./strings.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { liftBorrow, liftOwn } from "./handles.ts";
import {
  type CaseType,
  type ComponentValue,
  despecialize,
  discriminantType,
  type FieldType,
  type ValType,
} from "./types.ts";

export const MAX_LIST_BYTE_LENGTH = (1 << 28) - 1;

export function load(
  cx: LiftLowerContext,
  ptr: number,
  t: ValType,
): ComponentValue {
  const mem = requireMemory(cx.opts);
  assert_(ptr === alignTo(ptr, alignment(t, mem.ptrType())), "load misaligned");
  assert_(ptr + elemSize(t, mem.ptrType()) <= mem.length, "load OOB");
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      return convertIntToBool(loadIntU(mem, ptr, 1));
    case "u8":
      return loadIntU(mem, ptr, 1);
    case "u16":
      return loadIntU(mem, ptr, 2);
    case "u32":
      return loadIntU(mem, ptr, 4);
    case "u64":
      return loadIntU(mem, ptr, 8);
    case "s8":
      return loadIntS(mem, ptr, 1);
    case "s16":
      return loadIntS(mem, ptr, 2);
    case "s32":
      return loadIntS(mem, ptr, 4);
    case "s64":
      return loadIntS(mem, ptr, 8);
    case "f32":
      return decodeI32AsFloat(loadIntU(mem, ptr, 4));
    case "f64":
      return decodeI64AsFloat(loadIntU(mem, ptr, 8));
    case "char":
      return convertI32ToChar(loadIntU(mem, ptr, 4));
    case "string":
      return loadString(cx, ptr);
    case "error-context":
      throw new NotImplemented("error-context lift (needs task machinery)");
    case "list":
      return loadList(cx, ptr, d.element, d.length ?? null);
    case "record":
      return loadRecord(cx, ptr, d.fields);
    case "variant":
      return loadVariant(cx, ptr, d.cases);
    case "flags":
      return loadFlags(cx, ptr, d.labels);
    case "own":
      return liftOwn(cx, loadIntU(mem, ptr, 4), d);
    case "borrow":
      return liftBorrow(cx, loadIntU(mem, ptr, 4), d);
    case "stream":
    case "future":
      throw new NotImplemented("stream/future lift (needs copy machinery)");
  }
}

export function convertIntToBool(i: number): boolean {
  assert_(i >= 0);
  return Boolean(i);
}

export function loadList(
  cx: LiftLowerContext,
  ptr: number,
  elemType: ValType,
  maybeLength: number | null,
): ComponentValue {
  if (maybeLength !== null) {
    return loadListFromValidRange(cx, ptr, maybeLength, elemType);
  }
  const mem = requireMemory(cx.opts);
  const begin = loadPtr(mem, ptr);
  const length = loadPtr(mem, ptr + mem.ptrSize());
  return loadListFromRange(cx, begin, length, elemType);
}

export function loadListFromRange(
  cx: LiftLowerContext,
  ptr: number | bigint,
  length: number | bigint,
  elemType: ValType,
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const size = elemSize(elemType, mem.ptrType());
  const align = alignment(elemType, mem.ptrType());
  const byteLengthBig = BigInt(length) * BigInt(size);
  trapIf(byteLengthBig > BigInt(MAX_LIST_BYTE_LENGTH), "list too long");
  const ptrBig = BigInt(ptr);
  trapIf(ptrBig % BigInt(align) !== 0n, "misaligned list pointer");
  trapIf(ptrBig + byteLengthBig > BigInt(mem.length), "list out of bounds");
  return loadListFromValidRange(cx, Number(ptrBig), Number(length), elemType);
}

export function loadListFromValidRange(
  cx: LiftLowerContext,
  ptr: number,
  length: number,
  elemType: ValType,
): ComponentValue {
  const mem = requireMemory(cx.opts);
  // PLAN.md §7: list<u8> lifts to a Uint8Array copy.
  if (despecialize(elemType).kind === "u8") {
    return bytesOf(mem, ptr, length).slice();
  }
  const size = elemSize(elemType, mem.ptrType());
  const a: ComponentValue[] = [];
  for (let i = 0; i < length; i++) {
    a.push(load(cx, ptr + i * size, elemType));
  }
  return a;
}

export function loadRecord(
  cx: LiftLowerContext,
  ptr: number,
  fields: FieldType[],
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const record: { [label: string]: ComponentValue } = {};
  let p = ptr;
  for (const field of fields) {
    p = alignTo(p, alignment(field.type, mem.ptrType()));
    record[field.label] = load(cx, p, field.type);
    p += elemSize(field.type, mem.ptrType());
  }
  return record;
}

export function loadVariant(
  cx: LiftLowerContext,
  ptr: number,
  cases: CaseType[],
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const discSize = elemSize(discriminantType(cases), mem.ptrType());
  const caseIndex = loadIntU(mem, ptr, discSize as 1 | 2 | 4);
  let p = ptr + discSize;
  trapIf(caseIndex >= cases.length, "invalid variant discriminant");
  const c = cases[caseIndex];
  p = alignTo(p, maxCaseAlignment(cases, mem.ptrType()));
  if (c.type === null) return { [c.label]: null };
  return { [c.label]: load(cx, p, c.type) };
}

export function loadFlags(
  cx: LiftLowerContext,
  ptr: number,
  labels: string[],
): ComponentValue {
  const mem = requireMemory(cx.opts);
  const i = loadIntU(mem, ptr, elemSizeFlags(labels) as 1 | 2 | 4);
  return unpackFlagsFromInt(i, labels);
}

export function unpackFlagsFromInt(
  i: number,
  labels: string[],
): { [label: string]: ComponentValue } {
  const record: { [label: string]: ComponentValue } = {};
  let v = i >>> 0;
  for (const l of labels) {
    record[l] = Boolean(v & 1);
    v = v >>> 1;
  }
  return record;
}
