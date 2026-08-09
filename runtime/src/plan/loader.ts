// Plan loader: formatVersion validation, structural checks, and conversion
// of the wire descriptor IR (contracts/descriptor-ir.md JSON) into the cabi
// in-memory type model (runtime/src/cabi/types.ts, the normative model).
//
// Wire -> in-memory deltas handled here (recorded in the M0 contract
// friction report):
//   - `result.err` (wire, per descriptor-ir.md) -> `result.error` (types.ts)
//   - func params `{label, type}[]` (wire) -> unlabeled `ValType[]`
//     (types.ts drops ABI-irrelevant names; labels are preserved separately
//     for bindgen/digest use)
//   - own/borrow `resource: <table index>` (wire) -> `ResourceTypeInfo`
//     identity tokens created per resource table at load time

import {
  type FuncType,
  ResourceTypeInfo,
  type ValType,
} from "../cabi/types.ts";
import type {
  WireEnvelope,
  WireErrorDetail,
  WirePlan,
  WireTypeDecl,
  WireValType,
} from "./format.ts";

/** Fault in the plan document itself (version/shape/reference errors). */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * A structured translation verdict from the shim (envelope `errorDetail`).
 *
 * Distinguished from `PlanError` on purpose: a `TranslateError` with
 * `phase === "validation"` is *the translator's judgment about the input
 * component* and is the only failure that satisfies `assert_invalid` /
 * `assert_malformed`. `PlanError` and the other phases are failures of our
 * own pipeline and must never be scored as conformance passes.
 */
export class TranslateError extends Error {
  readonly phase: WireErrorDetail["phase"];
  readonly detail: string;

  constructor(d: WireErrorDetail) {
    super(`translator error [${d.phase}]: ${d.message}`);
    this.name = "TranslateError";
    this.phase = d.phase;
    this.detail = d.detail ?? d.message;
  }

  /** True iff the shim judged the *input component* invalid or malformed. */
  get isValidationVerdict(): boolean {
    return this.phase === "validation";
  }
}

/**
 * The single formatVersion this executor understands.
 *
 * v2 (M2 phase 2c): `streamTables` / `futureTables` — the element types the
 * stream and future built-ins need to size their copy buffers.
 * v1 (contracts/plan-format.md v0.3): `CoreDef` gained `"unsafe-intrinsic"`.
 * The change is purely additive, but the contract's compat rule is a strict
 * equality check ("Validate `formatVersion` and fail fast on mismatch",
 * producer and consumer bumped in the same commit), so v0 plans are refused
 * rather than best-effort accepted — a stale cached artifact must be a loud
 * failure, not a subtly different execution.
 */
export const SUPPORTED_FORMAT_VERSION = 2;

/** A types-table entry after conversion. */
export type LoadedType =
  | { kind: "func"; funcType: FuncType; paramNames: string[] }
  | { kind: "value"; type: ValType };

export interface LoadedPlan {
  wire: WirePlan;
  /** Converted types table, index-aligned with `wire.types`. */
  types: LoadedType[];
  /**
   * Identity tokens for resource tables, index-aligned with
   * `wire.resourceTables`. The executor fills `impl`/`dtor` while running
   * `resource` initializers.
   */
  resourceTokens: ResourceTypeInfo[];
  /**
   * Number of imported resource types. `ResourceIndex =
   * numImportedResources + DefinedResourceIndex`
   * (plan-format.md v0.1 amendment #2 / v0.2 `importedResources`).
   */
  numImportedResources: number;
  /** Element type per stream table (plan v2); `null` = zero-width payload. */
  streamElems: (ValType | null)[];
  /** Element type per future table (plan v2). */
  futureElems: (ValType | null)[];
  /** Owning component instance per stream/future table (plan v2). */
  streamTableInstances: number[];
  futureTableInstances: number[];
}

/**
 * Validate a plan document and convert its type tables. Fails fast on
 * formatVersion mismatch per contracts/plan-format.md "Executor obligations".
 */
export function loadPlan(wire: WirePlan): LoadedPlan {
  if (wire.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    throw new PlanError(
      `unsupported plan formatVersion ${wire.formatVersion} ` +
        `(this runtime implements v${SUPPORTED_FORMAT_VERSION})`,
    );
  }
  for (
    const required of [
      "modules",
      "initializers",
      "trampolines",
      "canonicalOptions",
      "types",
      "resourceTables",
      "imports",
      "exports",
    ] as const
  ) {
    if (!Array.isArray(wire[required])) {
      throw new PlanError(`plan.${required} missing or not an array`);
    }
  }

  const importedResources = wire.importedResources ?? [];
  for (const [i, ir] of importedResources.entries()) {
    if (
      typeof ir?.import !== "number" || ir.import < 0 ||
      ir.import >= wire.imports.length
    ) {
      throw new PlanError(
        `importedResources[${i}].import = ${ir?.import} is not a valid ` +
          `index into plan.imports (length ${wire.imports.length})`,
      );
    }
  }

  // Identity tokens: one per RESOURCE, aliased through every table that
  // names it — NOT one per table. plan-format.md C2 amendment #1: "one
  // resource type can be reachable through several distinct table indices …
  // Consumers keying per-resource state must key by `resourceTables[n]
  // .resource`, treating table indices as aliases." Minting per-table broke
  // exactly the way that warning predicts (found by the #18 polymorph-tls
  // smoke): in a wac-composed component the source and destination future
  // tables of a FACT transfer resolve `own<R>` through different table
  // indices, and `valTypeEqual`'s documented reference-identity comparison
  // (cabi/types.ts) saw two tokens for one resource — "future: destination
  // element mismatch" on every resource-bearing element type. wasmtime
  // interns identity at the `ResourceIndex` level and its transfer libcall
  // never re-compares element types at runtime (47.0.3
  // futures_and_streams.rs `guest_transfer`); unifying here restores parity
  // for every structural-equality site at once. Abstract tables keep
  // per-table tokens (no `resource` to key by; none in the current corpus).
  const tokenByResource = new Map<number, ResourceTypeInfo>();
  const resourceTokens = wire.resourceTables.map((table) => {
    if (table.kind !== "concrete") return new ResourceTypeInfo(null, null);
    let token = tokenByResource.get(table.resource);
    if (token === undefined) {
      token = new ResourceTypeInfo(null, null);
      tokenByResource.set(table.resource, token);
    }
    return token;
  });
  const types = wire.types.map((t, i) =>
    loadTypeDecl(t, resourceTokens, `types[${i}]`)
  );
  const elems = (ts: { element: WireValType | null }[] | undefined, what: string) =>
    (ts ?? []).map((t, i) =>
      t.element === null
        ? null
        : loadValType(t.element, resourceTokens, `${what}[${i}].element`)
    );
  return {
    wire,
    types,
    resourceTokens,
    numImportedResources: importedResources.length,
    streamElems: elems(wire.streamTables, "streamTables"),
    futureElems: elems(wire.futureTables, "futureTables"),
    streamTableInstances: (wire.streamTables ?? []).map((t) => t.instance),
    futureTableInstances: (wire.futureTables ?? []).map((t) => t.instance),
  };
}

/**
 * Component-wide `ResourceIndex` for a `DefinedResourceIndex` (the `index`
 * field of a `resource` initializer). Mirrors wasmtime
 * `Component::resource_index` (wasmtime-environ 47.0.3
 * `component/info.rs:222`).
 */
export function resourceIndexOfDefined(
  plan: LoadedPlan,
  definedIndex: number,
): number {
  return plan.numImportedResources + definedIndex;
}

/**
 * Parse the shim's C-ABI JSON envelope into a validated wire plan + adapter
 * bytes. The plan is validated (formatVersion, type tables) but returned in
 * wire form: the executor re-runs `loadPlan` per instantiation so resource
 * identity tokens are fresh per component instance.
 */
export function loadEnvelope(json: string): {
  wire: WirePlan;
  adapters: Map<string, Uint8Array>;
} {
  let envelope: WireEnvelope;
  try {
    envelope = JSON.parse(json) as WireEnvelope;
  } catch (e) {
    throw new PlanError(`envelope is not valid JSON: ${e}`);
  }
  if (envelope.error !== undefined) {
    // v0.1 producers send only `error`; treat the missing structured verdict
    // as "internal" — an unknown phase must never be read as a validation
    // verdict (see TranslateError).
    throw new TranslateError(
      envelope.errorDetail ??
        { phase: "internal", message: envelope.error },
    );
  }
  if (!envelope.plan) throw new PlanError("envelope missing `plan`");
  loadPlan(envelope.plan); // validate early; discard (see docstring)
  const adapters = new Map<string, Uint8Array>();
  for (const a of envelope.adapters ?? []) {
    adapters.set(a.file, base64Decode(a.wasm));
  }
  return { wire: envelope.plan, adapters };
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loadTypeDecl(
  t: WireTypeDecl,
  resourceTokens: ResourceTypeInfo[],
  where: string,
): LoadedType {
  if (t.kind === "func") {
    const decl = t as Extract<WireTypeDecl, { kind: "func" }>;
    return {
      kind: "func",
      funcType: {
        params: decl.params.map((p) =>
          loadValType(p.type, resourceTokens, `${where}.params.${p.label}`)
        ),
        results: decl.results.map((r, i) =>
          loadValType(r, resourceTokens, `${where}.results[${i}]`)
        ),
        async: decl.async,
      },
      paramNames: decl.params.map((p) => p.label),
    };
  }
  return {
    kind: "value",
    type: loadValType(t as WireValType, resourceTokens, where),
  };
}

export function loadValType(
  t: WireValType,
  resourceTokens: ResourceTypeInfo[],
  where: string,
): ValType {
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
    case "error-context":
      return { kind: t.kind };
    case "list":
      return {
        kind: "list",
        element: loadValType(t.element, resourceTokens, `${where}.element`),
        ...(t.length !== undefined ? { length: t.length } : {}),
      };
    case "record":
      return {
        kind: "record",
        fields: t.fields.map((f) => ({
          label: f.label,
          type: loadValType(f.type, resourceTokens, `${where}.${f.label}`),
        })),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: t.elements.map((e, i) =>
          loadValType(e, resourceTokens, `${where}[${i}]`)
        ),
      };
    case "variant":
      return {
        kind: "variant",
        cases: t.cases.map((c) => ({
          label: c.label,
          type: c.type === null
            ? null
            : loadValType(c.type, resourceTokens, `${where}.${c.label}`),
        })),
      };
    case "enum":
      return { kind: "enum", labels: [...t.labels] };
    case "option":
      return {
        kind: "option",
        type: loadValType(t.type, resourceTokens, `${where}.some`),
      };
    case "result":
      return {
        kind: "result",
        ok: t.ok === null
          ? null
          : loadValType(t.ok, resourceTokens, `${where}.ok`),
        // Wire name is `err` (descriptor-ir.md); in-memory name is `error`
        // (cabi/types.ts).
        error: t.err === null
          ? null
          : loadValType(t.err, resourceTokens, `${where}.err`),
      };
    case "map":
      return {
        kind: "map",
        key: loadValType(t.key, resourceTokens, `${where}.key`),
        value: loadValType(t.value, resourceTokens, `${where}.value`),
      };
    case "flags":
      return { kind: "flags", labels: [...t.labels] };
    case "own":
    case "borrow": {
      const rt = resourceTokens[t.resource];
      if (rt === undefined) {
        throw new PlanError(
          `${where}: ${t.kind} references resource table ${t.resource}, ` +
            `but the plan has ${resourceTokens.length} resource tables`,
        );
      }
      return { kind: t.kind, rt };
    }
    case "stream":
    case "future":
      return {
        kind: t.kind,
        element: t.element === null
          ? null
          : loadValType(t.element, resourceTokens, `${where}.element`),
      };
    default: {
      const exhaustive: never = t;
      throw new PlanError(
        `${where}: unknown ValType kind ${(exhaustive as WireValType).kind}`,
      );
    }
  }
}
