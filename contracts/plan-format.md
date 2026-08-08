# Contract: Plan Format v0

The **plan** is the translator shim's output: everything the TS runtime needs
to instantiate and link one component, derived deterministically from the
component binary. This document is the interface between `crates/translator-shim`
(producer) and `runtime/` (consumer). It is one of the three M0 contract
documents (with [descriptor-ir.md](descriptor-ir.md) and
[intrinsics.md](intrinsics.md)).

Status: **v0 — no stability promise until M1 exit.** Changes require updating
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
  // ("unsafe-intrinsic" is rejected by the shim in v0 — report if ever hit.)

  // Host trampolines (ComponentTranslation::trampolines), one per
  // wasmtime_environ::component::Trampoline variant. v0 executors implement
  // the sync subset and must fail loudly (at *instantiate* time, not call
  // time) on unimplemented kinds. Full kind list: see intrinsics.md §B.
  "trampolines": [
    { "kind": "lower-import", "index": 0, "lowered": 0,
      "options": 0 /* -> canonicalOptions */, "type": 0 /* -> types */ },
    { "kind": "resource-drop", "resource": 0, "async": false },
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
