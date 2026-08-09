// Canonical ABI — provisional component value-type model.
//
// This is the v1 sketch of the "CABI descriptor IR" of docs/architecture.md §8: the type
// information the host-boundary lift/lower interpreter walks. It mirrors the
// type classes of the executable spec
// (third_party/component-model/design/mvp/canonical-abi/definitions.py) as a
// TypeScript discriminated union, holding only what lift/lower needs.
//
// PROVISIONAL — expected to change when the translator shim (docs/architecture.md §4.2)
// defines the real plan format. Open questions, tracked in runtime/README.md:
//   - Serialized encoding (this in-memory shape vs the plan's wire format).
//   - Whether labels stay strings or become interned indices in the IR.
//   - Host-facing value representations for tuple/variant/option/result
//     (currently the despecialized definitions.py shapes; bindgen §9 will
//     want arrays / tagged unions / undefined-based options).
//   - Resource types: here an opaque token; the plan will carry resource-type
//     indices + dtor references instead.

/** Core wasm value types, as strings (mirrors definitions.py flat types). */
export type CoreType = "i32" | "i64" | "f32" | "f64";

/** Pointer type of a linear memory: wasm32 or wasm64. */
export type PtrType = "i32" | "i64";

/**
 * A flat core function signature (definitions.py `CoreFuncType`).
 * Equality is structural (see `coreFuncTypeEquals`).
 */
export interface CoreFuncType {
  params: CoreType[];
  results: CoreType[];
}

export function coreFuncTypeEquals(a: CoreFuncType, b: CoreFuncType): boolean {
  return a.params.length === b.params.length &&
    a.results.length === b.results.length &&
    a.params.every((p, i) => p === b.params[i]) &&
    a.results.every((r, i) => r === b.results[i]);
}

/** String encodings selectable by canonical options. */
export type StringEncoding = "utf8" | "utf16" | "latin1+utf16";

/**
 * Opaque token standing in for the implementing component instance of a
 * resource type (definitions.py `ResourceType.impl`). The value interpreter
 * only ever compares these by identity.
 */
export interface InstanceLike {
  handles: unknown; // Table — typed loosely here to avoid a cycle; see handles.ts
  mayLeave: boolean;
}

/**
 * definitions.py `ResourceType`: identity + implementing instance + optional
 * destructor. Compared by object identity everywhere.
 */
export class ResourceTypeInfo {
  constructor(
    public impl: InstanceLike | null,
    public dtor: ((rep: number) => void) | null = null,
  ) {}
}

// ---------------------------------------------------------------------------
// Value types (definitions.py ValType hierarchy)
// ---------------------------------------------------------------------------

export type PrimKind =
  | "bool"
  | "s8"
  | "u8"
  | "s16"
  | "u16"
  | "s32"
  | "u32"
  | "s64"
  | "u64"
  | "f32"
  | "f64"
  | "char"
  | "string";

export interface PrimType {
  kind: PrimKind;
}
export interface ErrorContextType {
  kind: "error-context";
}
export interface ListType {
  kind: "list";
  element: ValType;
  /** Fixed-length list when present (list<t, n>). */
  length?: number;
}
export interface FieldType {
  label: string;
  type: ValType;
}
export interface RecordType {
  kind: "record";
  fields: FieldType[];
}
export interface TupleType {
  kind: "tuple";
  elements: ValType[];
}
export interface CaseType {
  label: string;
  type: ValType | null;
}
export interface VariantType {
  kind: "variant";
  cases: CaseType[];
}
export interface EnumType {
  kind: "enum";
  labels: string[];
}
export interface OptionType {
  kind: "option";
  type: ValType;
}
export interface ResultType {
  kind: "result";
  ok: ValType | null;
  error: ValType | null;
}
export interface MapType {
  kind: "map";
  key: ValType;
  value: ValType;
}
export interface FlagsType {
  kind: "flags";
  labels: string[];
}
export interface OwnType {
  kind: "own";
  rt: ResourceTypeInfo;
}
export interface BorrowType {
  kind: "borrow";
  rt: ResourceTypeInfo;
}
export interface StreamType {
  kind: "stream";
  element: ValType | null;
}
export interface FutureType {
  kind: "future";
  element: ValType | null;
}

export type ValType =
  | PrimType
  | ErrorContextType
  | ListType
  | RecordType
  | TupleType
  | VariantType
  | EnumType
  | OptionType
  | ResultType
  | MapType
  | FlagsType
  | OwnType
  | BorrowType
  | StreamType
  | FutureType;

/**
 * definitions.py `FuncType`, without parameter/result names (names do not
 * affect the ABI; bindings generation reads WIT instead — docs/architecture.md §9).
 * `results` holds zero or one type in current CM, but stays a list to mirror
 * the reference (`FuncType.result`).
 */
export interface FuncType {
  params: ValType[];
  results: ValType[];
  async?: boolean;
}

// ---------------------------------------------------------------------------
// Component-level values (host-side JS representations, docs/architecture.md §7)
// ---------------------------------------------------------------------------

/**
 * Host-side value representation produced by lifting / consumed by lowering:
 *   bool         -> boolean
 *   u8..u32, s8..s32, f32, f64 -> number
 *   u64, s64     -> bigint
 *   char         -> single-code-point string
 *   string       -> string (plain; see README on dropped encoding provenance)
 *   list<u8>     -> Uint8Array (copy; docs/architecture.md §7) — other lists -> Array
 *   record       -> { [fieldLabel]: value }
 *   tuple        -> despecialized record { "0": v0, "1": v1, ... }
 *   variant/enum/option/result -> single-key object { [caseLabel]: payload|null }
 *   flags        -> { [label]: boolean }
 *   own/borrow   -> number (the resource rep at this layer)
 * These mirror definitions.py's Python shapes; final host-facing bindings
 * representations are an open question (README).
 */
/**
 * Opaque host token for the async value types.
 *
 * `stream`, `future` and `error-context` do not lift to plain data: the
 * reference's `lift_async_value` (definitions.py line 1530) yields the
 * *shared* stream/future object itself, because its identity is the value —
 * two components holding ends of one stream must see each other's copies.
 * Concretely these are `SharedStreamImpl`, `SharedFutureImpl` and
 * `ErrorContext` instances (runtime/src/task/streams.ts); they are declared
 * opaquely here to keep `cabi/types.ts` free of a dependency on the task
 * layer. Host code should treat one as a token and pass it back unchanged.
 *
 * LIMITATION: this brand is *structural*, so an all-optional interface admits
 * any object — it documents intent, it does not enforce it. The enforcement is
 * at the lowering sites, which `assert_` on the concrete class before using a
 * value (`lowerStream`/`lowerFuture` in cabi/async_values.ts check
 * `instanceof SharedStreamImpl`/`SharedFutureImpl`). A nominal brand would
 * need a required property, which the real classes could not satisfy without
 * cabi importing the task layer — the cycle this declaration exists to avoid.
 */
export interface AsyncValue {
  readonly __asyncValue?: never;
}

export type ComponentValue =
  | AsyncValue
  | boolean
  | number
  | bigint
  | string
  | null
  | Uint8Array
  | ComponentValue[]
  | { [label: string]: ComponentValue };

/** Core (flat) values: numbers for i32/f32/f64 lanes, bigints for i64 lanes. */
export type CoreValue = number | bigint;

// ---------------------------------------------------------------------------
// Despecialization (definitions.py `despecialize`)
// ---------------------------------------------------------------------------

export type DespecializedValType = Exclude<
  ValType,
  TupleType | EnumType | OptionType | ResultType | MapType
>;

export function despecialize(t: ValType): DespecializedValType {
  switch (t.kind) {
    case "tuple":
      return {
        kind: "record",
        fields: t.elements.map((e, i) => ({ label: String(i), type: e })),
      };
    case "enum":
      return {
        kind: "variant",
        cases: t.labels.map((l) => ({ label: l, type: null })),
      };
    case "option":
      return {
        kind: "variant",
        cases: [{ label: "none", type: null }, { label: "some", type: t.type }],
      };
    case "result":
      return {
        kind: "variant",
        cases: [{ label: "ok", type: t.ok }, { label: "error", type: t.error }],
      };
    case "map":
      return {
        kind: "list",
        element: despecialize({
          kind: "tuple",
          elements: [t.key, t.value],
        }),
      };
    default:
      return t;
  }
}

// ---------------------------------------------------------------------------
// Discriminants (definitions.py `discriminant_type`)
// ---------------------------------------------------------------------------

export function discriminantType(cases: CaseType[]): PrimType {
  const n = cases.length;
  if (!(0 < n && n < 2 ** 32)) throw new Error("assertion failed: case count");
  // mirrors math.ceil(log2(n)/8): 0|1 -> u8, 2 -> u16, 3 -> u32
  if (n <= 256) return { kind: "u8" };
  if (n <= 65536) return { kind: "u16" };
  return { kind: "u32" };
}

// ---------------------------------------------------------------------------
// Type predicates (definitions.py `contains_borrow` etc.)
// ---------------------------------------------------------------------------

export function containsBorrow(t: ValType | null): boolean {
  return contains(t, (u) => u.kind === "borrow");
}

export function containsAsyncValue(t: ValType | null): boolean {
  return contains(t, (u) => u.kind === "stream" || u.kind === "future");
}

export function contains(
  t: ValType | null,
  p: (t: DespecializedValType) => boolean,
): boolean {
  if (t === null) return false;
  const d = despecialize(t);
  switch (d.kind) {
    case "list":
      return p(d) || contains(d.element, p);
    case "stream":
    case "future":
      return p(d) || contains(d.element, p);
    case "record":
      return p(d) || d.fields.some((f) => contains(f.type, p));
    case "variant":
      return p(d) || d.cases.some((c) => contains(c.type, p));
    default:
      return p(d);
  }
}
