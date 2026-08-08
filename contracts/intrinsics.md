# Contract: Host Intrinsics v0

Everything the TS runtime must provide to wasm it did not author: (A) imports
of FACT-generated adapter modules, and (B) host trampolines referenced from
the plan (`CoreDef::Trampoline` / `lower-import`). Producers of the
requirement: the translator shim (per-plan manifest). Implementor: the runtime
(`runtime/src/intrinsics/`).

Status: **v0.2** (amended post-M0 and post-M1 — see amendment sections).

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
- `UnsafeIntrinsic` (`CoreDef` variant): **resolved at M2 phase 1** — now
  wire-represented per plan-format.md v1 amendments; the four
  `context-{get,set}-i32-{0,1}` symbols are implemented (per-thread storage),
  the 17 raw-host-memory symbols are refused at instantiate time.

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

## v0.2 amendments (post-M1)

1. **ResourceTransfer semantics pinned**: `resource-transfer-borrow`
   registers the source handle as a lender on the current sync-call scope
   and increments `num_lends` **unconditionally — borrow handles may be
   re-lent onward** (`definitions.py lift_borrow`/`Subtask.add_lender`; a
   lent handle blocks `resource.drop` until the call returns). Same-instance
   transfers take the rep fast path but still register the lender.
2. **Trap-unwind obligations**: when a trap escapes a FACT sync-call
   bracket, the host must unwind sync-call scopes (releasing lenders) AND
   restore `may_leave` on all component instances — FACT clears it around
   lift/lower and a trap skips its restore; without both unwinds the
   instance is unusable for post-trap re-entry, which this runtime
   deliberately supports.
3. **Host-trap preservation across nested barriers**: the trap trampoline
   must (re)record the pending trap before every throw, so the specific
   message survives arbitrarily nested adapter exception barriers. Residual,
   documented limitation: our traps are JS exceptions, so a guest
   `try_table catch_all` can observe them mid-flight (wasmtime's are
   unforgeable); full unforgeability would need an out-of-band poison flag.
4. **`Transcoder` trampoline parameters are plan-visible**: `op` (one of the
   12 `Transcode` ops), `from`/`to` runtime-memory indices, `from64`/`to64`.
   Semantics authority is wasmtime's libcalls (partial-progress primitives
   driving FACT's realloc/retry protocol), NOT definitions.py's whole-string
   transcoding model. All 12 ops implemented and reference-tested.
5. **Trap messages align to wasmtime's `Display for Trap` texts** (with the
   `wasm trap: ` prefix where wasmtime uses it) — the official suite asserts
   these strings, and wasmtime-compat is a plan goal.
6. **v0.3 discussion item** (from `values/variants.wast:83`): one
   async-lifted export currently makes a component's sync exports
   unreachable (instantiate-time refusal of `task-return`). The rule is
   correct per #5; a future amendment could permit lazily-trapping
   trampolines for exports the embedder never calls — deliberate
   silent-acceptance tradeoff, not adopted without discussion.
