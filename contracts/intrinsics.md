# Contract: Host Intrinsics v0

Everything the TS runtime must provide to wasm it did not author: (A) imports
of FACT-generated adapter modules, and (B) host trampolines referenced from
the plan (`CoreDef::Trampoline` / `lower-import`). Producers of the
requirement: the translator shim (per-plan manifest). Implementor: the runtime
(`runtime/src/intrinsics/`).

Status: **v0.1** (v0 amended post-M0 — see "v0.1 amendments"; the §A/§B
split turned out simpler in reality than as first written).

Sources of truth (pinned `wasmtime-environ 47.0.3`):
- (A) `wasmtime_environ::fact::Import` — every import FACT can emit.
- (B) `wasmtime_environ::component::Trampoline` — every host trampoline the
  plan can reference.
The shim must fail translation with a clear error if it encounters a variant
not yet representable in the plan (never silently drop).

## Universal semantics

1. **Synchronous, non-suspending.** Every intrinsic and trampoline body runs
   to completion in JS and returns. JS frames here are compatible with JSPI
   because they complete before any suspension occurs (PLAN.md §5). An
   intrinsic that needs to wait is a design error — waiting belongs to the
   task core.
2. **Traps** are thrown as the runtime's `ComponentTrap` and must not be
   catchable by guest code (they propagate through wasm as JS exceptions).
3. **Reentrance/state rules** (instance flags, `task_may_block`,
   enter/exit bookkeeping) implement the Component Model invariants — the
   engine (JSPI) will not enforce them for us.

## A. FACT adapter imports

Import-module namespaces observed in generated adapters (spike, S0):
`sync`, `async`, `transfer`, `transcode`, `callee`, `post_return`, `m<N>`
(memories), `f<N>` (funcs), `flags`, `runtime`, `instance`, `callback`.

By `fact::Import` variant — implementation obligations:

| Variant | Obligation (v0) |
|---|---|
| `CoreDef` wiring (callee funcs, memories, instance flags globals, `TaskMayBlock` global) | resolved from plan `CoreDef` encoding; flags are real `WebAssembly.Global(i32, mutable)` per component instance; `task-may-block` is one runtime-managed mutable global |
| `Trap` | throw `ComponentTrap` |
| `EnterSyncCall` / `ExitSyncCall` | sync-call task bookkeeping (task core; degenerate-case implementation in M0: assert-and-count) |
| `Transcode` (all ops: copies + utf8/utf16/latin1 conversions) | TextEncoder/TextDecoder + typed-array copies against the adapter-referenced memories; op enumeration follows `fact::Transcode` |
| `ResourceTransferOwn` / `ResourceTransferBorrow` | handle-table moves between component instances (M1, resources milestone) |
| `PrepareCall` / `SyncStartCall` / `AsyncStartCall` | task-core call protocol (M2; sync fixtures may hit `PrepareCall`+`SyncStartCall` earlier — implement as sync task bracket) |
| `FutureTransfer` / `StreamTransfer` / `ErrorContextTransfer` | async handle moves (M2) |

## B. Host trampolines (`Trampoline` enum)

Grouped by milestone at which the runtime must stop instantiate-failing them:

- **M0**: `LowerImport` (host function call through descriptor-IR lift/lower),
  `ResourceDrop` (sync path incl. dtor call rules of PLAN.md §7 — needed as
  soon as resources fixtures run, may slip to M1), `TaskReturn` (needed by
  any callback-ABI guest; M0 hello is sync — instantiate-fail is acceptable
  until M2 if unreferenced).
- **M1**: `ResourceNew`, `ResourceRep`, `Transcoder` (trampoline form).
- **M2 (task core)**: `BackpressureInc/Dec`, `TaskReturn`, `TaskCancel`,
  `WaitableSetNew/Wait/Poll/Drop`, `WaitableJoin`, `ThreadYield`,
  `SubtaskDrop/Cancel`, `Stream*`, `Future*`, `ErrorContext*`, `ContextGet/Set`.

(The authoritative variant list is the enum itself; this table asserts the
schedule, not the inventory. The shim emits the full typed list into
`plan.json` `trampolines`; the runtime's coverage assertion at instantiate
time is what keeps this table honest.)

## Manifest

`plan.json` carries, per adapter module, its full import list categorized by
the table in §A (`modules[].intrinsics`), and the full `trampolines` table.
The runtime asserts coverage at instantiate time and reports *which
milestone's* obligations are missing — "this component needs the M2 task
core" is a feature, not a crash.

## Open items (v0)

- Exact `Transcode` op inventory to implement in M0/M1 (drive from fixtures:
  utf8 copies first; the full matrix is already reference-tested in
  `runtime/src/cabi/strings.ts`).
- `UnsafeIntrinsic` (`CoreDef` variant): rejected by the shim; known M2
  blocker for wit-bindgen async guests (`context-{get,set}-i32-{0,1}`) — see
  plan-format.md v0.1 amendments.

## v0.1 amendments (post-M0 reality)

1. **§A collapses into CoreDef wiring.** `translate/adapt.rs`
   (`fact_import_to_core_def`) folds *every* `fact::Import` into
   instantiation-argument `CoreDef`s — the runtime never sees `fact::Import`
   directly. Intrinsic-like imports arrive as `CoreDef::Trampoline` entries
   (Trap, Enter/ExitSyncCall, Transcoder, ResourceTransfer*, PrepareCall,
   *StartCall, *Transfer) or plain wiring (callee funcs, memories, flags
   globals, task-may-block). The per-adapter manifest is import-names ×
   resolved args, categorized — which is exactly what the shim emits.
2. **Instance flags decided** (was an open item): one
   `WebAssembly.Global(i32, mutable, initial 1)` per component instance
   serves as both the FACT-visible flags global and host-side `may_leave`;
   FACT 47 reads/writes it as a plain 0/1 boolean (no bitmask).
   `may_enter` is host-only state, not in the global.
3. **`task-may-block` initial value = 1** (sync tasks may block).
4. **`Trap` carries an i32 code.** v0.1 maps all codes to `ComponentTrap`;
   enumerate codes later for diagnostics.
5. **Lazy materialization is the general rule**: trampolines/intrinsics are
   materialized at first *reference during instantiation* — unreferenced
   unsupported kinds never fail, referenced unsupported kinds fail at
   instantiate time with a milestone-aware message. ("Instantiate-time, never
   call-time" is preserved.)
