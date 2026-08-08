# Contract: Plan Format v0

The **plan** is the translator shim's output: everything the TS runtime needs
to instantiate and link one component, derived deterministically from the
component binary. This document is the interface between `crates/translator-shim`
(producer) and `runtime/` (consumer). It is one of the three M0 contract
documents (with [descriptor-ir.md](descriptor-ir.md) and
[intrinsics.md](intrinsics.md)).

Status: **v0.2** (amended post-M0 and post-M1 — see amendment sections). No
stability promise until M1 exit review completes. Changes require updating
both producer and consumer in the same commit and bumping `formatVersion`.

## Decisions (with rationale)

1. **Own schema, not wasmtime's.** `wasmtime_environ::component::Component`
   derives `Serialize`, which makes the *shim's mapping code* cheap — but its
   shape is an unstable internal API and is never exposed in the plan. The
   plan schema is defined here and owned by us (PLAN.md §4.2). The shim is
   the only code that sees both shapes.
2. **JSON encoding for v0.** Debuggable, diffable, good enough. Revisit
   (postcard / custom section) only on measured need.
3. **No duplicate bytes.** Embedded core modules are referenced as
   `[offset, len)` byte ranges into the original component binary — the
   executor slices them itself. Only FACT adapter modules (bytes that don't
   exist in the input) ship as separate artifacts.
4. **Types, not precomputed lanes.** The plan carries component-level types
   (descriptor IR); flattening is computed in the runtime by shared,
   reference-tested rules. See descriptor-ir.md "Flattening".

## Artifact set

A translation produces, content-addressed by
`sha256(component) x shim version x feature flags`:

```
plan.json                 this document's schema
adapters/<idx>.wasm       FACT-generated core modules (kilobytes each)
```

The original component binary is the third input at instantiation time; the
plan never embeds it.

## plan.json schema (v0)

```jsonc
{
  "formatVersion": 0,
  "producer": {
    "shimVersion": "…",              // crates/translator-shim crate version
    "wasmtimeEnviron": "47.0.3",     // exact pinned version
    "features": ["cm-async", "…"]    // wasmparser feature set used
  },
  "component": { "sha256": "…", "len": 123 },

  // Static module index space: embedded modules first, then FACT adapters,
  // exactly as wasmtime-environ returns them (PrimaryMap<StaticModuleIndex>).
  "modules": [
    { "kind": "embedded", "offset": 10, "len": 52 },
    { "kind": "adapter",  "file": "adapters/2.wasm", "len": 290,
      "intrinsics": [ /* see intrinsics.md: required imports, categorized */ ]
    }
  ],

  // Ordered instantiation program. One entry per
  // wasmtime_environ::component::GlobalInitializer, tag-for-tag:
  //   instantiate-module | lower-import | extract-memory | extract-realloc |
  //   extract-callback | extract-post-return | extract-table | resource
  "initializers": [
    { "op": "instantiate-module", "module": 0,
      "instance": 0,               // RuntimeComponentInstanceIndex; null = adapter
      "args": [ /* CoreDef */ ] },
    { "op": "lower-import", "index": 0, "import": 0 },
    { "op": "extract-memory", "index": 0, "export": { /* CoreExport */ } },
    { "op": "extract-realloc", "index": 0, "def": { /* CoreDef */ } },
    { "op": "extract-callback", "index": 0, "def": { /* CoreDef */ } },
    { "op": "extract-post-return", "index": 0, "def": { /* CoreDef */ } },
    { "op": "extract-table", "index": 0, "export": { /* CoreExport */ } },
    { "op": "resource", "index": 0, "rep": "i32", "dtor": { /* CoreDef? */ },
      "instance": 0 }
  ],

  // CoreDef encoding (wasmtime_environ::component::CoreDef, tag-for-tag):
  //   { "kind": "export", "instance": n, "item": {…} }      core instance export
  //   { "kind": "instance-flags", "instance": n }           i32 flags global
  //   { "kind": "trampoline", "index": n }                  host trampoline
  //   { "kind": "task-may-block" }                          runtime-managed global
  // ("unsafe-intrinsic" is rejected by the shim — KNOWN BLOCKER: wit-bindgen
  //  0.60 async guests produce CoreDef::UnsafeIntrinsic for
  //  context-{get,set}-i32-{0,1}; representing these is the M2 plan
  //  extension. Sync corpus is unaffected.)
  //
  // CoreExport.item encoding (pinned): wasmtime's ExportItem is
  // Index(EntityIndex) | Name(String); a JS embedder can only address core
  // exports by *name*, so the shim resolves Index via Module::exports
  // inversion and always emits:
  //   { "name": "…", "space": "func" | "table" | "memory" | "global" | "tag" }

  // Host trampolines (ComponentTranslation::trampolines), one per
  // wasmtime_environ::component::Trampoline variant. v0 executors implement
  // the sync subset and must fail loudly (at *instantiate* time, not call
  // time) on unimplemented kinds. Full kind list: see intrinsics.md §B.
  "trampolines": [
    { "kind": "lower-import", "lowered": 0 /* LoweredIndex */,
      "options": 0 /* -> canonicalOptions */, "type": 0 /* -> types */ },
    { "kind": "resource-drop", "instance": 0, "resource": 0 },
    { "kind": "task-return", "results": 0 /* -> types */, "options": 0 }
    // …
  ],

  // Canonical options table (Component::options), referenced by index from
  // trampolines and exports. Mirrors wasmtime_environ CanonicalOptions:
  "canonicalOptions": [
    { "instance": 0, "stringEncoding": "utf8",   // utf8|utf16|latin1+utf16
      "memory": 0,          // RuntimeMemoryIndex | null
      "realloc": 0,         // RuntimeReallocIndex | null
      "postReturn": null,   // RuntimePostReturnIndex | null
      "callback": null,     // RuntimeCallbackIndex | null
      "async": false, "cancellable": false,
      "coreType": { "params": ["i32","i32"], "results": ["i32"] } }
  ],

  // Component-level type table: descriptor-ir.md ValType/FuncType JSON.
  // Referenced by index from trampolines, imports and exports.
  "types": [ /* descriptor IR */ ],

  // World surface. Import names use the component's exact import strings;
  // runtime import indices match wasmtime's RuntimeImportIndex order.
  "imports": [ { "name": "…", "kind": "func", "type": 0 } ],
  "exports": [ { "name": "greet", "kind": "lifted-func",
                 "coreDef": { /* CoreDef */ }, "options": 0, "type": 0 } ],

  // Structural digest of the typed world surface, for the bindgen
  // instantiate-time handshake (PLAN.md §9). v0: sha256 over a canonical
  // JSON serialization of {imports, exports, types} with names sorted.
  "worldDigest": "sha256:…"
}
```

## Determinism

Byte-identical `plan.json` + adapters for identical
`(component bytes, shim build, features)`. JSON emission must use stable key
order and no floats-as-locale. This property is what makes the artifact cache
(PLAN.md §10) a pure content-address lookup — treat any nondeterminism as a
bug.

## Executor obligations

- Validate `formatVersion` and fail fast on mismatch.
- Execute `initializers` strictly in order; each op's semantics follow
  wasmtime-environ's documented behavior for the corresponding
  `GlobalInitializer` variant.
- Instantiate-time (not call-time) failure for any trampoline kind, intrinsic,
  or op the executor doesn't support.
- Verify `worldDigest` when typed bindings are in play (PLAN.md §9).

## Open items (v0)

- Resource table details beyond dtor wiring (borrow bookkeeping lives in the
  runtime; revisit when the shim emits resource-rich components).
- `values` section: out of scope (wasmtime parity, PLAN.md §7).
- Imported-module instantiation (`InstantiateModule::Import`) — not emitted
  for our current corpus; shim rejects with a clear error until implemented.
- Digest canonicalization details will firm up with bindgen (M1+).

## v0.1 amendments (post-M0 reality)

Additions/corrections from the M0 integration, normative as of v0.1:

1. **`resourceTables` section exists** (referenced by descriptor-IR
   `own`/`borrow` indices): index space = wasmtime `TypeResourceTableIndex`;
   entries `{"kind":"concrete", "resource": n, "instance": n}` or
   `{"kind":"abstract", "id": n}`.
2. **Imported resources gap**: `ResourceIndex` = `imported_resources.len() +
   DefinedResourceIndex`. The plan does not yet carry `importedResources`;
   the executor asserts none exist. Add the field when a corpus component
   imports a resource type.
3. **Types table carries two families**: descriptor-IR `ValType`s *and*
   function types tagged `{"kind":"func", "params": [{label,type}], "results":
   [...], "async": bool}` — `"func"` is not a ValType kind; consumers must
   discriminate.
4. **`imports` entries carry `path: string[]`** — wasmtime's
   `RuntimeImportIndex` is `(ImportIndex, Vec<String>)` walking into instance
   imports. (Untested: current corpus has no imports.)
5. **`canonicalOptions.memory/realloc` are flattened** from wasmtime's
   `data_model: CanonicalOptionsDataModel::LinearMemory{memory, realloc}`;
   the `Gc` data model is rejected per descriptor-ir.md.
6. Runtime instance/memory/realloc **counts are derivable, not carried**;
   executors create state lazily.
7. **`worldDigest` needs redesign before M1 bindgen**: currently digests
   types in interning order (deterministic per component, but not computable
   from WIT alone). The bindgen handshake requires an order-independent
   canonicalization. Structural, scheduled with bindgen.
8. Confirmations: adapter naming = static-module index; embedded
   `wasm_module_offset` equals slice position (shim-asserted); `NameMap` /
   `IndexMap` iteration is insertion-ordered (determinism holds).

## v0.2 amendments (post-M1)

1. **`importedResources` is now a spec'd field** (was amendment #2's gap):
   `[{"import": RuntimeImportIndex}]` in `ResourceIndex` order; optional on
   the wire (absent ⇒ empty, restoring v0.1 semantics). Executor obligation:
   `ResourceIndex = importedResources.length + DefinedResourceIndex`.
2. **Structured error envelope**: translation failures emit
   `{"error": "<message>", "errorDetail": {"phase": "validation" |
   "unsupported" | "internal", "message", "detail"?}}`. `errorDetail` is
   additive; only `phase: "validation"` may be scored as a correct
   `assert_invalid`/`assert_malformed` verdict. Body-validation failures in
   FACT-generated (non-embedded) modules classify as `internal`, never
   `validation`.
3. **`producer.features` expanded** (`cm-fixed-length-lists`, `cm-map`,
   `cm-implements`, `cm-threading`) — artifact-cache keys changed
   accordingly.
4. **`worldDigest` (shim-emitted) is legacy.** The normative digest is
   `cewd:1` per [digest.md](digest.md), computed by consumers from the
   plan's types/imports/exports at load time; the shim field is retained
   for wire compatibility but nothing may depend on it.
5. Known M2 blocker (unchanged, restated for visibility):
   `CoreDef::UnsafeIntrinsic` (`context-{get,set}-i32-{0,1}`) remains
   unrepresentable; the M2 plan extension owns it.

## v1 amendments (M2 phase 1)

1. **`formatVersion` is now `1`.** Additive change, but the compat rule is
   strict equality; producer and consumer bumped in the same commit. v0
   plans are refused — a stale cached artifact fails loudly rather than
   executing subtly differently.
2. **`CoreDef` gains `unsafe-intrinsic`** (supersedes v0.2 amendment #5):
   `{"kind": "unsafe-intrinsic", "intrinsic": "<symbol>"}` where the symbol
   is wasmtime's stable `UnsafeIntrinsic::name()` (`"context-get-i32-0"`,
   …), never the `#[repr(u32)]` ordinal (unstable internal). All 21 variants
   are wire-representable. Executor obligation: implement
   `context-{get,set}-i32-{0,1}` as canonical `context.{get,set}` over
   **per-thread** storage (definitions.py `Thread.storage`); refuse the 17
   raw-host-memory symbols at instantiate time.
3. **Carve-out to instantiate-time failure**: capability-scoped built-ins
   whose absence affects only the exports that use them (stream / future /
   error-context) may instantiate successfully and fail at first call — the
   failure must be `PendingCapability`-shaped, never a `Trap` (so it can
   never satisfy a conformance trap assertion). Rationale: one wit-bindgen
   guest routinely mixes supported callback-ABI exports with stream exports;
   instantiate-time refusal would make supported exports unreachable over a
   capability their code never touches.
4. **Open gap: no wire form for the component-instance tree.**
   `ComponentInstance.parent` drives the reference's `entering_set`; the
   flat instance space means nested instances never lock their ancestors —
   admitting reentrance the reference forbids. Pinned by a `// CONTRACT:`
   comment in `runtime/src/task/mod.ts`; fix is a nesting field in the plan,
   scheduled with the FACT-async work that will exercise it.
   (M2 phase-2c status: still unexercised by any suite case — FACT compiles
   the ancestor cases to unconditional compile-time traps.)

## v2 amendments (M2 phase 2c)

1. **`formatVersion` is now `2`** (strict equality both sides, same-commit
   bump rule as v1).
2. **`streamTables` / `futureTables` sections added**: entries
   `{"element": ValType | null, "instance": RuntimeComponentInstanceIndex}`,
   index spaces = wasmtime `TypeStreamTableIndex` / `TypeFutureTableIndex`.
   Rationale: stream/future trampolines carried table indices with no table
   section — a consumer could not size or lift a copy buffer from an opaque
   index. Digest-neutral: table sections do not enter the world digest
   (element types reach it only via function types on the world surface).
3. **Known gaps, same class, still open**: (a) `task_return_type` arrives as
   a wasmtime `TypeTupleIndex` with no mapping into `plan.types` — two
   `canon_task_return` checks remain skipped for FACT tasks (type-index
   comparison; memory-identity half of options equality — wasmtime's own
   check is one-sided and the adapter-view memory is second-hand);
   (b) `error-context` tables have no section — the transfer intrinsic
   reuses resource-table instance mapping, which fails loudly (never
   silently mis-routes) but is structurally the wrong index space. A v3
   should add `errorContextTables` and the `TypeTupleIndex` mapping
   together.
