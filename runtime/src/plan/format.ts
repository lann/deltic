// Plan v0 wire format (contracts/plan-format.md) — TypeScript mirror of the
// shim's serde schema (crates/translator-shim/src/plan.rs). Field names and
// shapes must track the Rust side tag-for-tag; the shim is the producer of
// record.

/** Core wasm lane types as emitted in `coreType` and `rep` fields. */
export type WireCoreType = "i32" | "i64" | "f32" | "f64";

export interface WirePlan {
  formatVersion: number;
  producer: {
    shimVersion: string;
    wasmtimeEnviron: string;
    features: string[];
  };
  component: { sha256: string; len: number };
  modules: WireModule[];
  initializers: WireInitializer[];
  trampolines: WireTrampoline[];
  canonicalOptions: WireCanonicalOptions[];
  types: WireTypeDecl[];
  resourceTables: WireResourceTable[];
  imports: WireImport[];
  exports: WireExport[];
  worldDigest: string;
}

export type WireModule =
  | { kind: "embedded"; offset: number; len: number }
  | {
    kind: "adapter";
    file: string;
    len: number;
    intrinsics: WireIntrinsicEntry[];
  };

export interface WireIntrinsicEntry {
  module: string;
  name: string;
  category: string;
  def: WireCoreDef;
}

export type WireInitializer =
  | {
    op: "instantiate-module";
    module: number;
    instance: number | null;
    args: WireCoreDef[];
  }
  | { op: "lower-import"; index: number; import: number }
  | { op: "extract-memory"; index: number; export: WireCoreExport }
  | { op: "extract-realloc"; index: number; def: WireCoreDef }
  | { op: "extract-callback"; index: number; def: WireCoreDef }
  | { op: "extract-post-return"; index: number; def: WireCoreDef }
  | { op: "extract-table"; index: number; export: WireCoreExport }
  | {
    op: "resource";
    index: number;
    rep: WireCoreType;
    dtor: WireCoreDef | null;
    instance: number;
  };

export type WireCoreDef =
  | { kind: "export"; instance: number; item: WireExportItem }
  | { kind: "instance-flags"; instance: number }
  | { kind: "trampoline"; index: number }
  | { kind: "task-may-block" };

export interface WireCoreExport {
  instance: number;
  item: WireExportItem;
}

export interface WireExportItem {
  name: string;
  space: "func" | "table" | "memory" | "global" | "tag" | "unknown";
}

/**
 * Trampoline declarations, tag-for-tag with the wasmtime `Trampoline` enum.
 * Only the M0-relevant variants are given precise field types; the rest are
 * matched by `kind` and rejected at instantiate time with milestone-aware
 * errors (contracts/intrinsics.md §B).
 */
export type WireTrampoline =
  | {
    kind: "lower-import";
    index: number;
    lowered: number;
    options: number;
    type: number;
  }
  | { kind: "trap"; index: number }
  | { kind: "enter-sync-call"; index: number }
  | { kind: "exit-sync-call"; index: number }
  | {
    kind: "task-return";
    index: number;
    instance: number;
    results: number;
    options: number;
  }
  | {
    kind: "resource-drop" | "resource-new" | "resource-rep";
    index: number;
    instance: number;
    resource: number;
  }
  | { kind: string; index: number; [field: string]: unknown };

export interface WireCanonicalOptions {
  instance: number;
  stringEncoding: "utf8" | "utf16" | "latin1+utf16";
  memory: number | null;
  realloc: number | null;
  postReturn: number | null;
  callback: number | null;
  async: boolean;
  cancellable: boolean;
  coreType: { params: WireCoreType[]; results: WireCoreType[] };
}

/** descriptor-ir.md ValType JSON (nested structurally). */
export type WireValType =
  | {
    kind:
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
      | "string"
      | "error-context";
  }
  | { kind: "list"; element: WireValType; length?: number }
  | { kind: "record"; fields: { label: string; type: WireValType }[] }
  | { kind: "tuple"; elements: WireValType[] }
  | { kind: "variant"; cases: { label: string; type: WireValType | null }[] }
  | { kind: "enum"; labels: string[] }
  | { kind: "option"; type: WireValType }
  | { kind: "result"; ok: WireValType | null; err: WireValType | null }
  | { kind: "map"; key: WireValType; value: WireValType }
  | { kind: "flags"; labels: string[] }
  | { kind: "own"; resource: number }
  | { kind: "borrow"; resource: number }
  | { kind: "stream"; element: WireValType | null }
  | { kind: "future"; element: WireValType | null };

export type WireTypeDecl =
  | {
    kind: "func";
    params: { label: string; type: WireValType }[];
    results: WireValType[];
    async: boolean;
  }
  | WireValType;

export type WireResourceTable =
  | { kind: "concrete"; resource: number; instance: number }
  | { kind: "abstract"; id: number };

export interface WireImport {
  name: string;
  path: string[];
  kind: string;
  type?: number;
}

export type WireExport =
  | {
    kind: "lifted-func";
    name: string;
    coreDef: WireCoreDef;
    options: number;
    type: number;
  }
  | { kind: "instance"; name: string; exports: WireExport[] }
  | { kind: "type"; name: string; type: WireTypeExport };

export type WireTypeExport =
  | { kind: "resource"; resource: number }
  | { kind: "value"; type: number };

/**
 * The shim's C-ABI envelope: plan + adapter artifacts in one JSON document
 * (crates/translator-shim/README.md documents the 1:1 mapping to the
 * contract's artifact set).
 */
export interface WireEnvelope {
  plan?: WirePlan;
  adapters?: { file: string; wasm: string }[];
  error?: string;
}
