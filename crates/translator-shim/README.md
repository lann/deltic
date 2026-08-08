# translator-shim

`wasmtime-environ`'s component frontend (validate, resolve linkage, FACT
fused-adapter synthesis) behind the stable **plan v0** output format of
[contracts/plan-format.md](../../contracts/plan-format.md). Promoted from the
S0 spike (`translator-spike`); PLAN.md §4.1/§4.2, milestone M0.

This crate is the only code in the repository that sees wasmtime's unstable
internal shapes; everything it emits is our own schema. Pinned:
`wasmtime-environ =47.0.3`, `wasmparser 0.252`.

## Artifact set vs C-ABI envelope

The contract defines the translation output as an artifact set:

```
plan.json                 (schema: contracts/plan-format.md)
adapters/<idx>.wasm       FACT-generated core modules
```

Over the wasm C-ABI (`ts_translate`), the shim returns the same artifact set
packed into **one JSON envelope** — a shim-internal wire format, mapped 1:1:

| Envelope field      | Contract artifact                                     |
|---------------------|-------------------------------------------------------|
| `plan`              | the `plan.json` document (as a JSON object; its byte form is this crate's serde serialization, which is deterministic) |
| `adapters[i].file`  | the artifact path, identical to `plan.modules[].file` (`adapters/<static module index>.wasm`) |
| `adapters[i].wasm`  | that artifact's bytes, base64 (standard alphabet, padded) |
| `error`             | (error envelopes only) failure message; no other field present |

Nothing else is in the envelope; consumers that want the on-disk artifact set
write `plan` and the decoded adapters out verbatim. The runtime-side decoder
is `runtime/src/plan/loader.ts` (`loadEnvelope`).

Determinism (contract requirement): plan JSON uses fixed struct-field order,
no maps, integers only; adapter bytes are FACT output, deterministic for a
pinned toolchain. `translate twice ⇒ byte-identical envelope` is asserted by
`tests/translate.rs::determinism` and by the runtime e2e test.

## API surface

- `translate(&[u8]) -> Result<Translation { plan, adapters }>` — library.
- `to_envelope_json(&Translation) -> Result<String>` — envelope.
- `cabi`: `ts_alloc` / `ts_translate` / `ts_dealloc` (wasm32 C-ABI; contract
  in `src/lib.rs`).
- `examples/dump-plan.rs` — debugging: dump a component's plan
  (`cargo run -p translator-shim --example dump-plan <component> [--full]`).
- `driver.ts` — Deno smoke driver over the wasm32 build
  (`deno run --allow-read driver.ts`).

## Build

```
cargo test -p translator-shim                                   # native tests
cargo build -p translator-shim --release --target wasm32-unknown-unknown
deno run --allow-read driver.ts                                 # smoke
```

Some tests use the example fixture corpus (`examples/guests/build/*.wasm`,
gitignored); they skip with a notice unless `./examples/build.sh` has run.

Size note: the default release wasm32 build is ~3.4 MiB. The S0 spike's
"1.66 MiB size-tuned" figure used size flags; reproduce without editing the
workspace manifest via:

```
cargo build -p translator-shim --release --target wasm32-unknown-unknown \
  --config 'profile.release.opt-level="z"' \
  --config profile.release.lto=true \
  --config profile.release.codegen-units=1 \
  --config 'profile.release.panic="abort"' \
  --config 'profile.release.strip=true'
```

## wasmtime-environ 47.0.3 API notes (feeds contract v0.1)

Recorded here because plan-format.md left these underspecified; the mapping
code is `src/plan.rs`.

- **Types**: obtained by calling `ComponentTypesBuilder::finish(&component)`
  *after* translation; the resulting `ComponentTypes` is `Index`able by every
  `Type*Index` and by `ModuleInternedTypeIndex` (core signatures for
  `canonicalOptions.coreType`). Counts like `num_resource_tables()` exist
  only on the builder — capture before `finish()`.
- **`Export` enum reality**: `LiftedFunction { ty: TypeFuncIndex, func:
  CoreDef, options: OptionsIndex }`, `Instance { ty, exports: NameMap }`
  (recursive), `Type(TypeDef)`, `ModuleStatic`/`ModuleImport` (rejected in
  v0). Options live in `Component::options`
  (`PrimaryMap<OptionsIndex, CanonicalOptions>`), *not* inline.
- **`CanonicalOptions` reality**: `memory`/`realloc` are nested inside
  `data_model: CanonicalOptionsDataModel::LinearMemory(LinearMemoryOptions)`;
  `Gc {}` is rejected. `StringEncoding::CompactUtf16` maps to the contract's
  `latin1+utf16`.
- **`ExportItem::Index(EntityIndex)`** cannot be consumed by a JS embedder
  (exports are name-addressed); the shim resolves indices to names via
  `Module::exports` and emits `{ name, space }`.
- **FACT adapter imports** are already folded to `CoreDef`s by
  `translate/adapt.rs` (`fact_import_to_core_def`): every §A intrinsic
  arrives as `CoreDef::Trampoline` (Trap, EnterSyncCall, Transcoder, ...) or
  a plain CoreDef (callee funcs, memories, instance-flags globals,
  task-may-block). The per-adapter `intrinsics` manifest is those args zipped
  with the adapter's import names, categorized by trampoline kind.
- **Instance flags**: FACT 47 treats the flags global as a plain boolean
  `may_leave` (no bit masks); initial value 1.
- **`ResourceDrop` has no `async` field** in 47.0.3 (`{ instance, ty }`) —
  plan-format.md's example shows one.
- **`CoreDef::UnsafeIntrinsic` is real**: wit-bindgen 0.60 async guests
  (`context.get`/`context.set`) produce it (variants
  `context-{get,set}-i32-{0,1}`). Plan v0 rejects it per contract; M2 must
  extend the plan format.
