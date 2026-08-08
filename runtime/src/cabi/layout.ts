// Alignment and element size (definitions.py `## Alignment`, `## Element
// Size`): byte layout of component values in linear memory.

import { assert_ } from "./trap.ts";
import { ptrSize } from "./memory.ts";
import {
  type CaseType,
  despecialize,
  discriminantType,
  type FieldType,
  type PtrType,
  type ValType,
} from "./types.ts";

export function alignTo(ptr: number, alignment: number): number {
  return Math.ceil(ptr / alignment) * alignment;
}

export function alignment(t: ValType, ptrType: PtrType): number {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
    case "s8":
    case "u8":
      return 1;
    case "s16":
    case "u16":
      return 2;
    case "s32":
    case "u32":
    case "f32":
    case "char":
      return 4;
    case "s64":
    case "u64":
    case "f64":
      return 8;
    case "string":
      return ptrSize(ptrType);
    case "error-context":
      return 4;
    case "list":
      return alignmentList(d.element, d.length ?? null, ptrType);
    case "record":
      return alignmentRecord(d.fields, ptrType);
    case "variant":
      return alignmentVariant(d.cases, ptrType);
    case "flags":
      return alignmentFlags(d.labels);
    case "own":
    case "borrow":
    case "stream":
    case "future":
      return 4;
  }
}

export function alignmentList(
  elemType: ValType,
  maybeLength: number | null,
  ptrType: PtrType,
): number {
  if (maybeLength !== null) return alignment(elemType, ptrType);
  return ptrSize(ptrType);
}

export function alignmentRecord(fields: FieldType[], ptrType: PtrType): number {
  let a = 1;
  for (const f of fields) a = Math.max(a, alignment(f.type, ptrType));
  return a;
}

export function alignmentVariant(cases: CaseType[], ptrType: PtrType): number {
  return Math.max(
    alignment(discriminantType(cases), ptrType),
    maxCaseAlignment(cases, ptrType),
  );
}

export function maxCaseAlignment(cases: CaseType[], ptrType: PtrType): number {
  let a = 1;
  for (const c of cases) {
    if (c.type !== null) a = Math.max(a, alignment(c.type, ptrType));
  }
  return a;
}

export function alignmentFlags(labels: string[]): number {
  const n = labels.length;
  assert_(0 < n && n <= 32, "flags label count");
  if (n <= 8) return 1;
  if (n <= 16) return 2;
  return 4;
}

export function elemSize(t: ValType, ptrType: PtrType): number {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
    case "s8":
    case "u8":
      return 1;
    case "s16":
    case "u16":
      return 2;
    case "s32":
    case "u32":
    case "f32":
    case "char":
      return 4;
    case "s64":
    case "u64":
    case "f64":
      return 8;
    case "string":
      return 2 * ptrSize(ptrType);
    case "error-context":
      return 4;
    case "list":
      return elemSizeList(d.element, d.length ?? null, ptrType);
    case "record":
      return elemSizeRecord(d.fields, ptrType);
    case "variant":
      return elemSizeVariant(d.cases, ptrType);
    case "flags":
      return elemSizeFlags(d.labels);
    case "own":
    case "borrow":
    case "stream":
    case "future":
      return 4;
  }
}

export function elemSizeList(
  elemType: ValType,
  maybeLength: number | null,
  ptrType: PtrType,
): number {
  if (maybeLength !== null) return maybeLength * elemSize(elemType, ptrType);
  return 2 * ptrSize(ptrType);
}

export function elemSizeRecord(fields: FieldType[], ptrType: PtrType): number {
  let s = 0;
  for (const f of fields) {
    s = alignTo(s, alignment(f.type, ptrType));
    s += elemSize(f.type, ptrType);
  }
  assert_(s > 0, "empty record");
  return alignTo(s, alignmentRecord(fields, ptrType));
}

export function elemSizeVariant(cases: CaseType[], ptrType: PtrType): number {
  let s = elemSize(discriminantType(cases), ptrType);
  s = alignTo(s, maxCaseAlignment(cases, ptrType));
  let cs = 0;
  for (const c of cases) {
    if (c.type !== null) cs = Math.max(cs, elemSize(c.type, ptrType));
  }
  s += cs;
  return alignTo(s, alignmentVariant(cases, ptrType));
}

export function elemSizeFlags(labels: string[]): number {
  const n = labels.length;
  assert_(0 < n && n <= 32, "flags label count");
  if (n <= 8) return 1;
  if (n <= 16) return 2;
  return 4;
}
