// Bidirectional value-shape adaptation (contracts/embedder-api.md
// §"Value mapping"; C2 checklist item 5).
//
// FROM: the runtime's raw boundary, whose shapes are the definitions.py
//       interpreter's — single-key variants (`{ "circle": 1.5 }`), `{some}` /
//       `{none}`, tuple-as-record (`{ "0": …, "1": … }`), `{ok}` / `{error}`
//       (note: the internal despecialization labels result's err case
//       `"error"`, not `"err"` — cabi/types.ts `despecialize`), kebab-case
//       record keys, resource handles as bare reps.
// TO:   the conventions: `{ tag, val? }` for variants and nested results,
//       outermost-option-as-`undefined` with nested boxing, real tuples,
//       camelCase record fields, flags objects, enum strings verbatim,
//       `Uint8Array` for `list<u8>`, class instances for resources,
//       `Stream`/`Future`/`ErrorContext` handles.
//
// The adapter is driven entirely by the plan's `ValType`s — no generated code
// participates, which is what lets the same facade serve an untyped embedder
// and a bindgen-typed one (the C2 design ruling: runtime-driven facade,
// compile-time-only bindgen).

import type { ComponentValue, ValType } from "../cabi/types.ts";
import { despecialize } from "../cabi/types.ts";
import { ErrorContext as InternalErrorContext } from "../task/mod.ts";
import { camelCase } from "./casing.ts";
import { NameCollisionError } from "./errors.ts";
import {
  type ElemCodec,
  ErrorContext,
  Future,
  lowerFutureSource,
  lowerStreamSource,
  Stream,
} from "./streams.ts";

/**
 * The parts of adaptation that need instance state: resources (identity
 * mapping, ownership) and the borrow scope of the call in flight.
 */
export interface ValueBridge {
  /** A guest handed the host an `own<R>`; the host now owns it. */
  liftOwn(rep: number, t: ValType & { kind: "own" }): unknown;
  /** A guest handed the host a `borrow<R>`, valid only for this call. */
  liftBorrow(
    rep: number,
    t: ValType & { kind: "borrow" },
    scope: BorrowScope,
  ): unknown;
  /** The host is passing an `own<R>` (transfer). */
  lowerOwn(v: unknown, t: ValType & { kind: "own" }): number;
  /** The host is passing a `borrow<R>` (no transfer). */
  lowerBorrow(v: unknown, t: ValType & { kind: "borrow" }): number;
}

/**
 * Wrappers materialized for `borrow<R>` arguments of one call. The contract:
 * "instance valid **only during the call** (retention throws)", so the scope
 * invalidates them when the call returns.
 */
export class BorrowScope {
  readonly #invalidate: (() => void)[] = [];

  add(f: () => void): void {
    this.#invalidate.push(f);
  }

  end(): void {
    for (const f of this.#invalidate) f();
    this.#invalidate.length = 0;
  }
}

/** A no-op scope for positions where no borrow can appear. */
export const NO_BORROWS = new BorrowScope();

/**
 * Label sets already checked for camelCase collisions. `ValType` objects are
 * stable for the lifetime of a loaded plan, so this is a one-time cost per
 * record/flags type rather than a per-call one.
 */
const checkedLabels = new WeakSet<object>();

/**
 * Refuse two labels in one scope that camelCase to the same JS name.
 *
 * `read-only` and `readOnly` are distinct WIT labels but one JS property, so
 * one would silently shadow the other at the boundary — values corrupted with
 * no diagnostic anywhere. Contract principle 2: footguns are design defects.
 */
export function checkNoCollisions(
  key: object,
  labels: string[],
  what: string,
): void {
  if (checkedLabels.has(key)) return;
  const seen = new Map<string, string>();
  for (const l of labels) {
    const js = camelCase(l);
    const held = seen.get(js);
    if (held !== undefined) {
      throw new NameCollisionError(
        `${what}: the labels '${held}' and '${l}' both map to the JS name ` +
          `'${js}'. Rename one in the WIT; the conventions layer will not ` +
          `guess which one wins.`,
      );
    }
    seen.set(js, l);
  }
  checkedLabels.add(key);
}

export interface AdapterOptions {
  bridge: ValueBridge;
  /** Names the site in error messages (`import 'wasi:x/y'.f`, param 2). */
  where: string;
}

// ---------------------------------------------------------------------------
// internal -> conventions
// ---------------------------------------------------------------------------

/**
 * Adapt one lifted value to its conventions shape.
 *
 * `inOption` implements the contract's option rule: the *outermost* option in
 * a chain maps to `T | undefined`; an option nested **directly inside another
 * option** boxes as `{ tag: "some", val } | { tag: "none" }`. Only option maps
 * to `undefined`, so this is the only ambiguity, and the flag is set only when
 * descending through an option's payload — every other constructor resets it.
 */
export function toHost(
  v: ComponentValue,
  t: ValType,
  o: AdapterOptions,
  scope: BorrowScope = NO_BORROWS,
  inOption = false,
): unknown {
  switch (t.kind) {
    case "bool":
    case "s8":
    case "u8":
    case "s16":
    case "u16":
    case "s32":
    case "u32":
    case "s64":
    case "u64":
    case "f32":
    case "f64":
    case "char":
    case "string":
      return v;
    case "error-context":
      return new ErrorContext(v as unknown as InternalErrorContext);
    case "list": {
      const elem = despecialize(t.element);
      if (elem.kind === "u8") {
        // Already a Uint8Array from the raw boundary (PLAN §7); copy defensively
        // only if the interpreter handed back a plain array (fixed-length lists
        // take the Uint8Array path too, but be tolerant).
        return v instanceof Uint8Array ? v : Uint8Array.from(v as number[]);
      }
      return (v as ComponentValue[]).map((e) => toHost(e, t.element, o, scope));
    }
    case "record": {
      checkNoCollisions(t, t.fields.map((f) => f.label), `${o.where}: record`);
      const src = v as Record<string, ComponentValue>;
      const out: Record<string, unknown> = {};
      for (const f of t.fields) {
        // "fields of option type are optional properties (`field?: T`)": a
        // `none` field is *absent*, not `undefined`-valued, so the object has
        // one canonical shape rather than two indistinguishable ones.
        if (f.type.kind === "option") {
          const inner = src[f.label] as Record<string, ComponentValue>;
          if ("none" in inner) continue;
          out[camelCase(f.label)] = toHost(
            inner["some"],
            f.type.type,
            o,
            scope,
            true,
          );
          continue;
        }
        out[camelCase(f.label)] = toHost(src[f.label], f.type, o, scope);
      }
      return out;
    }
    case "tuple": {
      const src = v as Record<string, ComponentValue>;
      return t.elements.map((et, i) => toHost(src[String(i)], et, o, scope));
    }
    case "variant": {
      const [label, payload] = single(v, o);
      const c = t.cases.find((c) => c.label === label);
      if (c === undefined) {
        throw new TypeError(`${o.where}: unknown variant case '${label}'`);
      }
      return c.type === null
        ? { tag: label }
        : { tag: label, val: toHost(payload, c.type, o, scope) };
    }
    case "enum": {
      // Enum values are data: kebab-case verbatim, never camelCased.
      const [label] = single(v, o);
      return label;
    }
    case "option": {
      const [label, payload] = single(v, o);
      if (inOption) {
        return label === "none"
          ? { tag: "none" }
          : { tag: "some", val: toHost(payload, t.type, o, scope, true) };
      }
      return label === "none"
        ? undefined
        : toHost(payload, t.type, o, scope, true);
    }
    case "result": {
      const [label, payload] = single(v, o);
      // Internal despecialization names the err case "error"; the contract's
      // tag is "err" (cabi/types.ts `despecialize`).
      const tag = label === "error" ? "err" : "ok";
      const ct = label === "error" ? t.error : t.ok;
      return ct === null ? { tag } : { tag, val: toHost(payload, ct, o, scope) };
    }
    case "flags": {
      checkNoCollisions(t, t.labels, `${o.where}: flags`);
      const src = v as Record<string, ComponentValue>;
      const out: Record<string, boolean> = {};
      for (const l of t.labels) out[camelCase(l)] = Boolean(src[l]);
      return out;
    }
    case "map": {
      // `map<K,V>` despecializes to `list<tuple<K,V>>`; keep that shape.
      return toHost(v, despecialize(t), o, scope);
    }
    case "own":
      return o.bridge.liftOwn(v as number, t);
    case "borrow":
      return o.bridge.liftBorrow(v as number, t, scope);
    case "stream":
      return Stream.fromLifted(v, elemCodec(t.element, o));
    case "future":
      return Future.fromLifted(v, elemCodec(t.element, o));
  }
}

function single(
  v: ComponentValue,
  o: AdapterOptions,
): [string, ComponentValue] {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(
      `${o.where}: expected a single-key case object, got ${describe(v)}`,
    );
  }
  const keys = Object.keys(v as Record<string, ComponentValue>);
  if (keys.length !== 1) {
    throw new TypeError(
      `${o.where}: expected exactly one case key, got ${keys.length}`,
    );
  }
  return [keys[0], (v as Record<string, ComponentValue>)[keys[0]]];
}

// ---------------------------------------------------------------------------
// conventions -> internal
// ---------------------------------------------------------------------------

export function fromHost(
  v: unknown,
  t: ValType,
  o: AdapterOptions,
  inOption = false,
): ComponentValue {
  switch (t.kind) {
    case "bool":
      return Boolean(v);
    case "u8":
      return int(v, t.kind, 0, 0xff, o);
    case "u16":
      return int(v, t.kind, 0, 0xffff, o);
    case "u32":
      return int(v, t.kind, 0, 0xffffffff, o);
    case "s8":
      return int(v, t.kind, -0x80, 0x7f, o);
    case "s16":
      return int(v, t.kind, -0x8000, 0x7fff, o);
    case "s32":
      return int(v, t.kind, -0x80000000, 0x7fffffff, o);
    case "u64":
      return big(v, t.kind, 0n, (1n << 64n) - 1n, o);
    case "s64":
      return big(v, t.kind, -(1n << 63n), (1n << 63n) - 1n, o);
    case "f32":
    case "f64":
      if (typeof v !== "number") {
        throw new TypeError(`${o.where}: ${t.kind} expects a number`);
      }
      return v;
    case "char": {
      if (typeof v !== "string" || [...v].length !== 1) {
        throw new TypeError(
          `${o.where}: char expects a single-code-point string`,
        );
      }
      // A lone surrogate has `[...v].length === 1` but is not a Unicode
      // scalar value, so `char` cannot hold it. Reject here, where the site is
      // known: the interpreter's own check reports only "not a valid char".
      const cp = v.codePointAt(0)!;
      if (cp >= 0xd800 && cp <= 0xdfff) {
        throw new TypeError(
          `${o.where}: char expects a Unicode scalar value, got the lone ` +
            `surrogate U+${cp.toString(16).toUpperCase()}`,
        );
      }
      return v;
    }
    case "string":
      if (typeof v !== "string") {
        throw new TypeError(`${o.where}: string expects a string`);
      }
      return v;
    case "error-context": {
      if (v instanceof ErrorContext) {
        return v.internal as unknown as ComponentValue;
      }
      if (v instanceof InternalErrorContext) return v as unknown as ComponentValue;
      throw new TypeError(`${o.where}: expected an ErrorContext`);
    }
    case "list": {
      const elem = despecialize(t.element);
      if (elem.kind === "u8") {
        if (v instanceof Uint8Array) return v;
        if (Array.isArray(v)) return Uint8Array.from(v as number[]);
        throw new TypeError(`${o.where}: list<u8> expects a Uint8Array`);
      }
      if (!Array.isArray(v)) {
        throw new TypeError(`${o.where}: list expects an array`);
      }
      return v.map((e) => fromHost(e, t.element, o));
    }
    case "record": {
      if (v === null || typeof v !== "object") {
        throw new TypeError(`${o.where}: record expects an object`);
      }
      checkNoCollisions(t, t.fields.map((f) => f.label), `${o.where}: record`);
      const src = v as Record<string, unknown>;
      const out: Record<string, ComponentValue> = {};
      for (const f of t.fields) {
        const key = camelCase(f.label);
        if (f.type.kind === "option") {
          // Absent and `undefined` both mean `none` — the two spellings of an
          // optional property.
          const inner = src[key];
          out[f.label] = inner === undefined
            ? { none: null }
            : { some: fromHost(inner, f.type.type, o, true) };
          continue;
        }
        if (!(key in src)) {
          throw new TypeError(`${o.where}: record field '${key}' is missing`);
        }
        out[f.label] = fromHost(src[key], f.type, o);
      }
      return out;
    }
    case "tuple": {
      if (!Array.isArray(v) || v.length !== t.elements.length) {
        throw new TypeError(
          `${o.where}: tuple expects an array of ${t.elements.length}`,
        );
      }
      const out: Record<string, ComponentValue> = {};
      t.elements.forEach((et, i) => {
        out[String(i)] = fromHost(v[i], et, o);
      });
      return out;
    }
    case "variant": {
      const { tag, val, has } = tagged(v, o);
      const c = t.cases.find((c) => c.label === tag);
      if (c === undefined) {
        throw new TypeError(`${o.where}: unknown variant case '${tag}'`);
      }
      if (c.type === null) return { [tag]: null };
      if (!has) {
        throw new TypeError(`${o.where}: variant case '${tag}' needs a 'val'`);
      }
      return { [tag]: fromHost(val, c.type, o) };
    }
    case "enum": {
      if (typeof v !== "string" || !t.labels.includes(v)) {
        throw new TypeError(
          `${o.where}: enum expects one of ${t.labels.join(" | ")}, got ` +
            describe(v),
        );
      }
      return { [v]: null };
    }
    case "option": {
      if (inOption) {
        const { tag, val, has } = tagged(v, o);
        if (tag === "none") return { none: null };
        if (tag !== "some") {
          throw new TypeError(
            `${o.where}: a nested option must be { tag: "some" | "none" }`,
          );
        }
        return { some: has ? fromHost(val, t.type, o, true) : null };
      }
      return v === undefined
        ? { none: null }
        : { some: fromHost(v, t.type, o, true) };
    }
    case "result": {
      const { tag, val, has } = tagged(v, o);
      if (tag !== "ok" && tag !== "err") {
        throw new TypeError(
          `${o.where}: a result value must be { tag: "ok" | "err" }`,
        );
      }
      const label = tag === "err" ? "error" : "ok";
      const ct = tag === "err" ? t.error : t.ok;
      if (ct === null) return { [label]: null };
      // Symmetric with the variant path above: a case that carries a payload
      // must be given one. Silently lowering `null` would put a zero where the
      // guest expects data.
      if (!has) {
        throw new TypeError(
          `${o.where}: result case '${tag}' carries a payload and needs a 'val'`,
        );
      }
      return { [label]: fromHost(val, ct, o) };
    }
    case "flags": {
      if (v === null || typeof v !== "object") {
        throw new TypeError(`${o.where}: flags expects an object`);
      }
      checkNoCollisions(t, t.labels, `${o.where}: flags`);
      const src = v as Record<string, unknown>;
      const out: Record<string, ComponentValue> = {};
      // "lower: absent = false" — an omitted flag is not an error.
      for (const l of t.labels) out[l] = Boolean(src[camelCase(l)]);
      return out;
    }
    case "map":
      return fromHost(v, despecialize(t), o);
    case "own":
      return o.bridge.lowerOwn(v, t);
    case "borrow":
      return o.bridge.lowerBorrow(v, t);
    case "stream":
      // deno-lint-ignore no-explicit-any
      return lowerStreamSource(v as any, elemCodec(t.element, o));
    case "future":
      // deno-lint-ignore no-explicit-any
      return lowerFutureSource(v as any, elemCodec(t.element, o));
  }
}

function tagged(
  v: unknown,
  o: AdapterOptions,
): { tag: string; val: unknown; has: boolean } {
  if (v === null || typeof v !== "object" || !("tag" in v)) {
    throw new TypeError(
      `${o.where}: expected a { tag, val? } value, got ${describe(v)}`,
    );
  }
  const rec = v as { tag: unknown; val?: unknown };
  if (typeof rec.tag !== "string") {
    throw new TypeError(`${o.where}: 'tag' must be a string`);
  }
  return { tag: rec.tag, val: rec.val, has: "val" in rec };
}

function int(
  v: unknown,
  kind: string,
  lo: number,
  hi: number,
  o: AdapterOptions,
): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new TypeError(`${o.where}: ${kind} expects an integer number`);
  }
  if (v < lo || v > hi) {
    throw new TypeError(`${o.where}: ${kind} out of range: ${v}`);
  }
  // The raw boundary takes unsigned lane values for the signed types too?
  // No: cabi `lowerFlatSigned32` does the two's-complement fold, so the
  // interpreter wants the *signed* number here. Pass it through.
  return v;
}

function big(
  v: unknown,
  kind: string,
  lo: bigint,
  hi: bigint,
  o: AdapterOptions,
): bigint {
  if (typeof v !== "bigint") {
    throw new TypeError(`${o.where}: ${kind} expects a bigint`);
  }
  if (v < lo || v > hi) {
    throw new TypeError(`${o.where}: ${kind} out of range: ${v}`);
  }
  return v;
}

/** Per-element codec for a `stream<T>` / `future<T>`. */
function elemCodec(
  element: ValType | null,
  o: AdapterOptions,
): ElemCodec<unknown> {
  return {
    element,
    where: o.where,
    toHost: (v) => element === null ? undefined : toHost(v, element, o),
    fromHost: (v) => element === null ? null : fromHost(v, element, o),
  };
}

export function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") return `a ${v.constructor?.name ?? "object"}`;
  return `a ${typeof v} (${String(v)})`;
}
