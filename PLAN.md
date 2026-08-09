# component-engine — Plan

A WebAssembly Component Model host built on the JS `WebAssembly` API, targeting
JSPI-capable engines. Primary development against Deno; conformance runs
against browsers. Aims for Component Model feature parity and compatibility
with wasmtime and wit-bindgen. **0.3.0 concurrency is the core deliverable.**

Status: design phase. This document records the architecture, the decisions
already made (with rationale), and the open questions.

---

## 1. Goals

- **Concurrency is the point.** Existing hosts already run non-async
  components fine; this project exists to be a first-class host for Component
  Model 0.3.0 concurrency — `async` lift/lower, tasks/subtasks,
  `stream`/`future` — mapped natively onto the JS event loop and JSPI.
  Sync-only operation is a supported subset, not a destination.
- Load, link, and run Component Model binaries (`.wasm` components) at runtime
  on stock JS engines, using only the JS `WebAssembly` API.
- Component Model feature parity with wasmtime, tracked against the official
  spec ([WebAssembly/component-model]).
- Compatibility with wasmtime-built and wit-bindgen-built guest components,
  sync and async alike, made executable via imported conformance/test
  suites. componentize-go output is a named second guest toolchain
  (consumer-driven, §17): callback-ABI async lifts + async-lowered imports
  from Go's patched runtime — a differently-shaped exerciser of the same
  ABI, which wasmtime runs correctly and jco does not.
- **Adoption target: replace jco as the JS host for the polymorph
  component family and experiment-mosh** (§17). Their JS-host legs are
  blocked on structural jco defects in exactly this project's core
  territory (0.3 concurrency). They have no external dependents, so
  embedder conventions co-evolve with them — designed against real
  consumers, not in the abstract. Success = their conformance matrices
  green on this host and the jco fork pins deleted.
- **"Parity" means functional parity, not behavioral identity.** The bar is:
  the same feature set, spec-conforming behavior, and wasmtime/wit-bindgen
  guests running correctly. Where the spec sanctions a range of behaviors,
  this host may — and does — diverge from wasmtime's choices (deterministic
  FIFO scheduling per §6; deterministic NaN profile; JS-native host value
  shapes). Wasmtime-identical observable behavior is adopted only where
  (a) something external forces it — the official suite's `assert_trap`
  matches message text, which is de facto wasmtime wording — or (b) it is
  free by construction (the translation frontend *is* wasmtime-environ, §4).
  Behavior mandated by the spec/reference (e.g. instance poisoning on trap,
  per definitions.py) is spec conformance, not wasmtime-matching, even when
  wasmtime exhibits it too. The tie-breaking authority for semantic
  questions is the spec + `definitions.py`, with wasmtime as corroborating
  evidence — never the other way around.
- TypeScript throughout the JS side: the runtime, the harness, and all
  generated bindings.
- A performance story that can get fast later without rearchitecting.

## 2. Non-goals

- **WASI implementations in the core.** `wasi:*` host packages are out of
  scope for the runtime itself; the finish line is Component Model support,
  demonstrated with custom WIT worlds. Two sanctioned carve-outs, both
  outside the core: WASI interface *shapes* are first-class design inputs
  to the embedder conventions (§17 / C1) — they are the ecosystem's most
  important interfaces and the conventions must serve them well — and a
  minimal WASI shim *package* (separate deliverable; consumer-driven scope:
  p2 cli/io/clocks/random baseline + p3 clocks) ships with the consumer
  track (C2).
- **Componentizing JS/TS.** Guests are components built by external toolchains
  (Rust + wit-bindgen is the reference). No embedded-JS-engine work.
- **jco compatibility or reuse.** Ignored entirely — including at the
  embedder-API level: we do not emulate jco's host conventions (thrown
  bare `{tag, val}` payloads, its `Stream` objects, transpile-time async
  enumerations); consumers port to our conventions (§17). Where we need
  prior art we take it from wasmtime; where jco's conventions have known
  footguns (documented defensively by the polymorph host modules
  themselves), we fix rather than inherit. Replacing jco for the named
  consumers is a goal (§1); *being* jco is not.
- **Pre-JSPI engines.** No fallback path for engines without JSPI.

## 3. Compatibility targets

Floor: engines supporting JSPI (proposal is **phase 4**; minor API drift is
still possible — it changed once already when the `Suspender` object was
removed).

| Engine | JSPI status | Role |
|---|---|---|
| Deno ≥ 2.3.2 | on by default | primary dev target |
| Chrome/Chromium ≥ 137 | on by default | CI |
| Firefox | flag: `javascript.options.wasm_js_promise_integration` | CI (pref flipped) |
| Safari / WebKit | Safari Technology Preview 238+, flagged | CI best-effort |
| Node ≥ 26 | on by default | optional, free after browser transpile |

Notes:

- Deno and Chrome share V8, so Firefox and WebKit provide the real engine
  diversity. Get Firefox into CI early. JSC's JSPI is the newest
  implementation — budget for filing engine bugs rather than assuming our code
  is wrong.
- **Type reflection (js-types) is phase 3 and flagged everywhere** — function
  signatures are not available from `WebAssembly.Module.imports()`. The
  architecture below sidesteps this (the translator emits all type
  information), but no design may assume type reflection exists.
- CSP: compiling from bytes requires `wasm-unsafe-eval`. The baseline design
  requires nothing beyond that. Full `unsafe-eval` is only needed for the
  optional generated-JS fast path (§8).

## 4. Architecture

One deterministic pipeline, run either at first load (and cached) or ahead of
time — "AOT" and "runtime linking" are the same code executed at different
moments.

```
                       Rust (compiled to wasm32, runs everywhere)
                     ┌──────────────────────────────────────────┐
 component.wasm ───► │ translator = wasmtime-environ (validate,  │
                     │ resolve linkage) + FACT (fused adapters)  │
                     │ + shim (stable output format)             │
                     └──────────────┬───────────────────────────┘
                                    │ artifacts (bytes, content-addressed)
                                    ▼
        ┌────────────────────────────────────────────────────┐
        │ plan: instantiation ops, type tables, CABI          │
        │       descriptors, required-intrinsics list         │
        │ core modules: byte ranges sliced from the component │
        │ adapter modules: FACT-generated core wasm           │
        └──────────────┬─────────────────────────────────────┘
                       │
                       ▼            TypeScript (platform-neutral)
        ┌────────────────────────────────────────────────────┐
        │ runtime: plan executor, host-boundary lift/lower,   │
        │ resource tables, intrinsics, reentrance gates,      │
        │ JSPI trampolines, 0.3 task scheduler (core)         │
        └────────────────────────────────────────────────────┘

 wit/*.wit ──► bindgen (Rust, wit-bindgen-core) ──► typed TS bindings
                                   (verified against the plan at instantiate())
```

### 4.1 Translator: wasmtime's frontend compiled to wasm

We reuse wasmtime's "decide what to do" layer, which is separable from its
"do it" layer and has no native-code dependency:

- `wasmtime-environ`'s component translator: parsing, validation, subtyping,
  and resolution of the component's linking structure into a flat
  instantiation plan.
- `wasmtime-environ::fact` (FACT): generates **fused adapters** — the glue for
  cross-component calls (canonical-ABI lift composed with lower) — **as plain
  core wasm modules** via `wasm-encoder`.

Why this is the cornerstone decision:

- **Wasmtime compatibility by construction.** We inherit wasmtime's
  interpretation of the spec for the largest correctness surface (validation,
  types, adapter semantics) and turn "compat with wasmtime" into a version pin.
- **It solves the JSPI stack-purity problem (§5) by construction** — all
  cross-component call paths are wasm, never JS.
- **It removes the hardest codegen** (flattening, param spilling, string
  transcoding, resource transfer, post-return) from our scope.

Constraints and mitigations:

- `wasmtime-environ` is an **internal, unstable API**. Mitigation: a thin Rust
  **shim** crate owns the dependency and maps environ's output into our own
  stable plan format. Wasmtime churn is confined to the shim. Pin wasmtime and
  wasm-tools versions; upgrade deliberately.
- FACT adapters import **host intrinsics** (string transcoders,
  `resource-transfer-own/borrow`, enter/exit bookkeeping, trap). The TS
  runtime implements this contract — specified in
  **[contracts/intrinsics.md](contracts/intrinsics.md)** — and the shim emits
  the required-intrinsics list per component so the contract is explicit at
  translation time, not discovered at instantiation. These intrinsics are
  synchronous JS calls that return before any suspension can occur —
  compatible with the JSPI frame rule.
- The translator ships as a **plain core wasm module** with a bytes-in/bytes-out
  ABI (no components-all-the-way-down bootstrap).
- Expected size: low single-digit MB. Fine for dev and Deno; a deferred
  concern for production web. (Being a real static asset ≥ 128 kB, browsers
  code-cache the translator itself well — the most expensive fixed cost of the
  pipeline is the part engines already handle.)

**Spike 0 (go/no-go, days not weeks):** compile
`wasmtime-environ` (component-model + fact) to wasm32; feed it a trivial
component; get plan + adapters out under Deno. In the same spike, verify the
pinned wasmtime's CM-async support end to end: async feature flags enabled in
the shim, and FACT's coverage of async↔sync fused-adapter combinations
confirmed on a toy async component.
**Fallback if it fails:** vendor the `fact` module (Apache-2.0) into our own
crate atop `wasm-encoder`/`wasmparser` and drive translation from `wasmparser`
directly. Same architecture, more maintenance.

### 4.2 Plan format

Specified in **[contracts/plan-format.md](contracts/plan-format.md)** (v0
pinned at M0). Summary of the fixed decisions:

- Defined by us, versioned, **operational content only**: instantiation ops,
  core-module slice ranges, adapter module references, canonical-ABI
  descriptors for host-boundary functions, type tables, required intrinsics,
  resource-type metadata (dtor references).
- **No WIT-level fidelity** (no docs, no feature gates, no aliasing
  structure) — bindings generation reads WIT source instead (§9). This keeps
  the format small and stable.
- Encoding: start with the simplest thing that round-trips (JSON or postcard);
  revisit only if measurable.
- Deterministic: identical inputs (component bytes, translator build, flags)
  produce identical artifacts. This is what makes caching trivial (§10).

### 4.3 TS runtime

Platform-neutral core (dependencies: `WebAssembly` JS API, `TextEncoder`/
`TextDecoder`, Promises — nothing else). Responsibilities:

1. Plan executor: compile sliced core modules and adapters, instantiate in
   plan order, wire imports/exports.
2. Host boundary: lift/lower per CABI descriptors (§8), `realloc`/
   `post-return` handling.
3. Resource machinery: slab handle tables, own/borrow tracking (`num_lends`,
   borrow invalidation at call return), dtor invocation (§7), FACT intrinsic
   implementations.
4. Reentrance gates: `may_enter`/`may_leave` enforcement — **JSPI happily
   permits reentry that the Component Model forbids**; the gates are ours to
   enforce and must hold while suspended.
5. Task scheduler (§6): the 0.3 task/thread model is the runtime's core
   structure, not an add-on — waitable sets, streams/futures, callback-ABI
   event dispatch, backpressure, cancellation. Sync calls are the degenerate
   case: a task driven to resolution before the call returns, exactly as in
   the reference implementation.

## 5. The JSPI frame rule (load-bearing constraint)

From the JSPI spec ([js-promise-integration Overview]):

> Only WebAssembly computations may be suspended: **only WebAssembly frames may
> be active between the call to a `promising` function and any call to a
> `Suspending` wrapped import** — a JS frame in between traps.

Consequences baked into this design:

- **Host boundary JS glue is safe.** A `Suspending`-wrapped import's JS runs to
  completion and returns a Promise; suspension happens after it returns, so
  host-side lift/lower in JS never sits on the suspended stack.
- **Cross-component glue must be wasm.** A JS adapter between components A and
  B would trap the moment anything below it suspends. FACT adapters keep those
  stacks pure wasm — this is why §4.1 is the cornerstone.
- **Component exports invoked from JS** that may transitively suspend must be
  entered through `WebAssembly.promising` trampolines. This includes
  JS-initiated resource drops (§7).
- **Guest-initiated cross-component dtor calls** route through generated wasm
  (direct funcref call in the adapter/intrinsic path), not a JS bounce.

## 6. Concurrency (the core deliverable)

Existing hosts handle non-async components adequately; 0.3.0 concurrency is
why this project exists. The runtime is therefore designed around the 0.3
task model **from day one** — sync-only operation falls out as the degenerate
case, exactly as in the reference implementation (`definitions.py`, where
`canon_lift` always creates a Task/Thread and the sync path is a driving loop
over the same structures). This ordering is deliberate: retrofitting the task
model onto a sync-first runtime is the rearchitecting we are not allowed to
need.

Mapping the reference model onto the web platform:

| Reference concept | Implementation |
|---|---|
| `Thread` (suspendable computation) | wasm activation entered via `WebAssembly.promising` |
| `Thread.wait_until` / blocking | call to a `Suspending` import returning a scheduler-controlled Promise |
| resume | scheduler resolves that Promise (event-loop turn) |
| scheduler | JS event loop + explicit ready queues; cooperative, matching the CM model — no preemption exists or is needed |
| `Waitable` / `WaitableSet` | host-side event structures; `wait` = suspension (stackful) or the callback return-code protocol (stackless) |
| callback ABI | no suspension at all: the scheduler invokes the callback export with events |
| sync `canon_lift` driving loop | same scheduler: pump ready threads until resolved, with the spec's deadlock trap |
| `Subtask`, backpressure, cancellation | direct ports of the reference structures |

JSPI's three roles, precisely:

1. **Stackful async lifts** (no-callback `async`) — the guest blocks mid-stack.
2. **Blocking sync lowers** — a caller waiting on an unresolved subtask
   (`thread.wait_until(subtask.resolved)` in the reference).
3. **Sync guests over async host imports** — falls out of the same mechanism;
   a useful capability, not a separate deliverable.

The callback ABI needs no JSPI (stackless by design), so the build order
within the concurrency work is: task core + callback ABI first (pure
event-loop bookkeeping, which JS is good at), then the JSPI-backed
stackful/blocking paths on the same task core. This is construction sequence,
not a phase boundary — concurrency is not done until `test/async` is green.
Empirical confirmation (S0 fixtures): wit-bindgen 0.60 emits **exclusively
callback-ABI async lifts** — running wit-bindgen async guests requires the
task core, not JSPI, so the build order front-loads exactly the compat that
matters.

Determinism note: the reference scheduler makes explicitly nondeterministic
choices (`random.choice` over ready threads). Our scheduler must stay inside
the spec's allowed nondeterminism while being reproducible enough to debug —
policy tracked in §16.

## 7. Canonical ABI decisions

Authority: [CanonicalABI.md] and its executable reference
(`design/mvp/canonical-abi/definitions.py`). Where the host has freedom, we
decide deliberately and document here.

- **Strings.** Component strings are USV sequences; JS strings are WTF-16.
  Lowering a JS string with lone surrogates uses WebIDL `USVString`
  replacement semantics (U+FFFD). Guest→host lift via `TextDecoder`;
  host→guest lower via `TextEncoder.encodeInto` directly into guest memory.
  `latin1+utf16` implemented in the v1 interpreter (the ported reference
  tests forced it immediately; wit-bindgen guests themselves use utf8).
- **Numbers.** `u64`/`s64` ↔ `BigInt`; everything else ↔ `number`.
  `list<u8>` ↔ `Uint8Array` (copy; views into guest memory are never exposed).
- **Memory views** are re-acquired after any call that can grow memory
  (`ArrayBuffer` detach on `memory.grow`).
- **Resources.** Host-facing handles are classes with `Symbol.dispose`
  (TS `using`), an explicit `[Symbol.dispose]()`/`drop()`, and a
  `FinalizationRegistry` backstop for leaks.
- **Destructors.** Per spec (CanonicalABI.md §`canon resource.drop`): the dtor
  is a core function `[rep] -> []`, invoked as a normal **non-async**
  cross-component call — *"the destructor may not block. However, the
  destructor may spawn a cooperative thread that does."* Reentrance is checked
  (`may_enter_from`) with the same-instance exemption. Host policy:
  - CM-level blocking in a dtor → deterministic trap (falls out of general
    sync-task rules).
  - Host-import latency is invisible to CM semantics; a dtor calling a
    `Suspending` host import is legal but needs a suspension-legal stack:
    JS-initiated drops (`using`, FinalizationRegistry) enter via a `promising`
    trampoline; guest-initiated drops stay on pure-wasm paths (§5).
  - Upstream spec findings related to drops and backpressure (vestigial
    `$async?` on `resource.drop`; dead `canon_backpressure_set` in
    definitions.py) are tracked in
    [upstream-component-model-repo-findings.md](upstream-component-model-repo-findings.md),
    the single source for component-model issue/PR filing. Implementation is
    sync-only drop regardless of upstream timing.
- **Component `value` imports/exports** (the component-level `value`
  definition feature): wasmtime doesn't implement them; excluded from parity
  scope. Note the official suite's `test/values/` directory is **not** this
  feature — it is plain canonical-ABI value-passing tests (`canon lift` with
  memory options) and is fully in scope (scope ruling corrected during M1;
  the directory is green).
- **Reentrance**: gates per spec Component Invariants, enforced in the runtime
  (see §4.3 item 4).

## 8. Performance strategy

Requirement: not critical now; must become fast **without rearchitecting**.

- **Cross-component calls are already the fast path**: FACT adapters, pure
  wasm, no JS in the hot path. Nothing to do later.
- **Host boundary** has two executors over one IR — specified in
  **[contracts/descriptor-ir.md](contracts/descriptor-ir.md)** (v0 pinned at
  M0):
  - The shim emits **CABI descriptor tables** (a compact ops IR per function).
  - v1: a generic interpreter walks descriptors. CSP-clean, everywhere.
  - v2 (when needed): generate specialized JS from the same descriptors.
    Deno: always available. Browsers: gated on CSP `unsafe-eval`, interpreter
    as fallback. Two executors over one IR double as a differential-testing
    oracle.
- Disciplines adopted now because they're hard to retrofit: slab handle
  tables; no per-call closure/object allocation on hot paths; view reuse with
  grow-aware invalidation; `encodeInto` for strings.
- Future options, noted not planned: JS string builtins (now widely shipped)
  for string-heavy host boundaries; deploy-time unbundling for engine code
  caching (§10).

## 9. Bindings generation

- A Rust CLI crate built on **wit-bindgen-core**, consuming
  `wit_parser::Resolve` + `WorldId`. **WIT source is the input** — the plan
  cannot reproduce high-fidelity bindings (docs are lost in binaries, feature
  gates are resolved away, aliasing is flattened) and the
  bindings-before-any-component workflow requires WIT anyway.
- Output: TypeScript — typed world/interface APIs, `.d.ts`, resource classes
  (`using`-compatible), JSDoc from WIT doc comments, honoring
  `@since`/`@unstable` gates.
- Host-facing value conventions (error model, stream/future wrappers,
  variant/option/result shapes, resource classes, module-per-interface
  authoring) are governed by the embedder conventions design
  (`contracts/embedder-api.md`, C1 in §13), which supersedes
  descriptor-ir.md's interim "target table". Bindgen also emits host-side
  types for **import worlds** (what an embedder must provide), not only
  export-side facades — the consumers' host modules (§17) are the
  reference consumers of that surface.
- **Skew protection, the wasmtime way**: the generator embeds a canonical
  structural digest of the expected world into the bindings;
  `instantiate()` verifies it against the loaded component's types (already
  computed by the translator) and fails fast with a useful diff.
  Compile-time fidelity from WIT; load-time truth from the binary.
- Secondary, degraded mode: bindings from a component binary via its decoded
  types (structure only, no docs). For third-party components; never primary.
- Guest-side bindings are stock wit-bindgen (Rust et al.) — that toolchain is
  the compatibility target, exercised by its own runtime tests (§11).
- Version pinning: wit-parser/wasm-tools pinned to the same versions as the
  translator's wasmtime, so WIT feature resolution matches.

## 10. Caching

Two independent layers; nothing may *depend* on the second.

1. **Artifact cache (ours, bytes only).** Content-addressed by
   `(component hash, translator build hash, flags)` — deterministic
   translation makes this trivial. Storage: Cache API/OPFS in browsers, a
   cache directory in Deno. Skips the translation stage on reload.
2. **Engine code caches (opportunistic).** Chrome's wasm code cache is keyed
   by URL but anchored to the **HTTP resource cache entry** (invalidation via
   304/200 semantics + V8 version), applies only to
   `compileStreaming`/`instantiateStreaming`, and only to modules **≥ 128 kB**
   after full tier-up. Consequences:
   - Service-worker-**synthesized** responses get streaming *compilation* but
     no persistent code cache (no HTTP cache entry to anchor to). Same
     conclusion in Firefox (alt-data on HTTP cache entries). Safari: no
     persistent wasm code cache known.
   - FACT adapters are kilobytes — under the threshold, never code-cached
     anyway. Only large sliced core modules matter; recurring cost is
     re-tier-up CPU, not startup latency (Liftoff is fast).
   - If a deployment has a build step: run the translator there (same wasm,
     under Deno) and publish artifacts at real URLs → full engine caching with
     zero tricks. Optionally warm via service-worker install-time
     `compileStreaming` of those real URLs.
   - Empirical check in M2: `chrome://tracing`, filter `v8.wasm`, look for
     `v8.wasm.cachedModule`/`v8.wasm.moduleCacheHit` on hot runs.

## 11. Conformance and testing

There is no single official conformance suite; the corpus is assembled:

| Source | What | How used |
|---|---|---|
| [WebAssembly/component-model] `test/` | official, growing WAST suite: `binary/`, `validation/`, `linking/`, `resources/`, `values/`, `async/` | git submodule; primary gate. All sync directories in scope incl. `values/` (CABI tests); `async/` gates M2. Independent check on the wasmtime-frontend reuse. |
| same repo, `design/mvp/canonical-abi/definitions.py` + `run_tests.py` | executable CABI reference | port lift/lower edge-case tests to TS unit tests |
| wit-bindgen runtime tests | guest programs exercising bindings | build Rust guests, sync and async, (wit-bindgen + `wasm-tools component new`); run against our host = the executable wit-bindgen-compat claim |
| wasmtime `tests/misc_testsuite/component-model/` | engine-grade wast corpus | supplementary coverage |
| polymorph conformance matrices (webcrypto/websocket/webrtc/tls, driven by polymorph-test) | per-interface implementation×environment conformance suites over real WIT surfaces | consumer lane (§17): a component-engine L3 runner executes them; release gate once C2 lands |
| experiment-mosh gates + minimized repros (`compose-async-tdz`) | composed 3-component client: mixed sync/async exports, background pumps, resources re-exported across interfaces, componentize-go guest | strongest known real-workload exercisers — this family surfaced ≥5 distinct jco defect classes no WAST corpus expresses |

Harness pipeline: an offline Rust step (`crates/testgen`) converts `.wast`
into JSON commands + `.wasm` binaries — the core-spec `wast2json` model. It
uses the `wast` crate directly (resolved: `wasm-tools json-from-wast`'s JSON
model is adequate, but the pinned CLI's bundled parser predates current suite
syntax — 15/59 files vs 59/59 with `wast` 255; owning the emitter also let us
tag every artifact `core` vs `component`, which the harness needs since V8
cannot even validate component binaries). The TS harness executes the JSON
identically under `deno test` and in browsers (static server + automated
Chrome / Firefox-with-pref / WebKit-best-effort).

Also planned: differential testing of interpreter vs generated-JS executors
(§8); later, differential fuzzing against native wasmtime with
`wasm-smith`-generated components.

Epistemic note: because our frontend *is* wasmtime's, wasmtime-derived tests
partly test wasmtime against itself — weight the official suite and
definitions.py ports accordingly.

## 12. Repository layout (proposed)

```
component-engine/
  PLAN.md
  contracts/                 # versioned interface contracts between workstreams
    plan-format.md           #   shim -> runtime artifact schema
    descriptor-ir.md         #   host-boundary lift/lower IR (one IR, two executors)
    intrinsics.md            #   FACT imports + host trampolines the runtime provides
    embedder-api.md          #   host-facing conventions (C1): errors, streams, resources, value shapes
  crates/                    # cargo workspace
    translator-shim/         # wasmtime-environ + FACT → plan + artifacts (wasm32 target)
    bindgen/                 # wit-bindgen-core TS backend (CLI)
    testgen/                 # wast → JSON + binaries preprocessing
  runtime/                   # TS core runtime (platform-neutral, no Deno APIs)
  harness/                   # conformance harness: deno test + browser runners
  examples/                  # custom WIT worlds + Rust guests (the demo path)
  third_party/
    component-model/         # submodule: spec + official tests + definitions.py
  tools/                     # CI scripts, browser drivers, artifact cache impl per platform
```

Deno workspace for TS; cargo workspace for Rust; translator wasm checked in as
a built artifact per release of the shim (reproducible from source).

## 13. Milestones

| # | Deliverable | Exit criteria |
|---|---|---|
| S0 | **Spike**: wasmtime-environ + FACT on wasm32 | **DONE — GO** (2026-08-08). `wasmtime-environ =47.0.3` builds for wasm32-unknown-unknown with zero imports; runs under Deno; FACT adapters (sync + async) emitted as core wasm; 1.66 MiB size-tuned (~0.5 MiB gzip); sub-ms steady-state translation. Fallback (vendoring FACT) not needed. See `crates/translator-spike/`. |
| M0 | Contracts + plan executor on the task-model skeleton | `contracts/{plan-format,descriptor-ir,intrinsics}.md` v0 pinned (the Phase-2 fan-out gate); spike promoted to `translator-shim` emitting plan v0; runtime structured around Task/Thread/Subtask from the start; **`examples/guests/build/hello.component.wasm` (real wit-bindgen guest: strings, realloc, post-return) runs in Deno** |
| M1 | Canonical ABI core | **DONE** (2026-08-08). Official suite green on Deno across all five sync directories — binary 119/122 (3 xfail: wasmtime-pin drift ×2, module-exports plan gap), validation 446/448 (+2 same-drift xfails), linking 272/272, resources 36/36, values 155/191 (+36 xfails, all M2-task-core-shaped) — zero unexpected failures; sync + async wit-bindgen guest fixtures roundtrip; transcoder trampoline (all 12 ops); imported resources; live component imports; structured verdicts; canonical world digest handshake (contracts/digest.md); typed TS facades for fixture worlds. Multi-agent per §15: 3 parallel tracks, 2 reviewer rounds (5 blocking findings fixed), interrupted mid-flight by a driver restart and recovered via task_id resumes. |
| M2 | **Concurrency complete on Deno** | **DONE** (2026-08-08, exit review APPROVE-WITH-NITS at 652c1dc). JSPI auto-detection ON by default; **1250/1349 executing suite commands pass, zero failures, every one of the 99 xfails in a named class** (47 wasmparser pin-drift → exits on wasmtime bump; 41 🧵-deferred cascades; 5 shim gaps; 6 small named residues). Delivered: the 0.3 task core, callback ABI, FACT cross-component calls (all four ABI combos), streams/futures/error-context with full rendezvous, host-side ends, cross-component cancellation, JSPI stackful+blocking paths with per-declaration suspendability, instance poisoning, deadlock detection with wasmtime-exact wording. wit-bindgen async roundtrip trio + producer guests green. Empirical engine pins (a)–(j) incl. "the fast path still suspends"; five JSPI host constraints recorded in contracts/intrinsics.md; two wasmtime-supersedes-reference findings (CM-3, CM-4) + NOTE-1 tracked upstream. Plain path pinned zero-cost for sync-only components. |
| M3 | Cross-engine | browser CI matrix (Chrome, Firefox+pref, WebKit best-effort); artifact cache; full suite green on all lanes; code-cache empirical check |
| C0 | **Consumer smoke test** (§17; the next gate) | Real consumer artifacts run under component-engine on Deno with throwaway glue, in order: experiment-mosh's `compose-async-tdz` repro (two tiny components, no shims — pins the lann/jco#51 shape semantically), iroh's `exec-model` probe (+ a p3-clock stub), the websocket conformance suite (first shim contact). Exit: discrepancy list triaged into {toolchain drift, missing shims, conventions gaps}; translator throughput measured on multi-MB componentize-go artifacts (largest translated to date: 94 KB; consumers ship 2–10.5 MB); wasmtime pin-bump decision made on the drift evidence (the bump also retires the 47-xfail pin-drift class from M2). Deno capability audit for the consumer host modules: WebRTC pre-answered empirically (`tools/probes/webrtc-deno/` — node-datachannel as a Node-API addon and pure-TS werift both pass a full data-channel loopback under Deno 2.9.5); remaining dgram/net-compat checks ride the smoke test under the real harnesses. |
| C1 | Embedder conventions design — `contracts/embedder-api.md` | **DONE** (2026-08-08, v0.1). All §16 sub-questions decided: branded `WitError` throw model (unbranded host throw = trap — the anti-jco-footgun inversion); `{tag, val}` variant family covering nested options and results-as-values; outermost-option-as-undefined rule; exports uniformly Promise-shaped; resource classes both directions with runtime-owned identity mapping; `Stream<T>`/`Future<T>` handles over web-native producers with auto-closing pumps; **semver-canonical version resolution** matching the spec's canonical-interface-names design and wasmtime's `NameMap`/`alternate_lookup_key` (exact-first, track-alternate max-wins, prerelease/`0.0.z` exact-only; unversioned folding stays banned — corrected same-day from an initial version-exact-only ruling after reviewing the spec §canonical-interface-names and wasmtime's linker); `requiredImports()` blessed. **WASI examined as ruled**: paper signatures for wasi:clocks p3, wasi:io p2 (pollable/streams — the one real friction, p2 sync-blocking, gets a three-tier strategy grounded in C0 finding #6), wasi:sockets p3 TCP, wasi:http p3 sketch, and webrtc data-channel; verdict — no new conventions needed. Supersedes descriptor-ir's interim table; implementation strategy: generated adapter over the raw boundary, interpreter shapes unchanged until P1. C2 checklist normative in the doc. |
| C2 | Conventions implemented + WASI shim package + L3 runner | **DONE** (2026-08-09). `runtime/src/embedder/` implements C1 (reviewed; 2 blocking + 9 advisories fixed); bindgen emits C1 types for 6 worlds, type-checking against the real module; `wasi-shims/` ships track-key providers (p2 baseline + p3 clocks incl. the D-1 union) — iroh exec-model runs with **zero hand stubs** and the 8 MB componentize-go mosh engine instantiates and answers `version()`; `ct-runner/` executes L1 suites host-providing `test-context` (ARCHITECTURE Rule 3) and emits schema-exact L4 JSONL (golden-tested against upstream's wire vocabulary). Two runtime defects found by the packages en route (facade bind-ordering; `task.return` type-check JSON cycle) — both fixed with fail-on-pre-fix pins. Residuals: runner upstreaming into polymorph-test is the operator's (foreign repo); consumer-suites-as-CI-gate activates with the C3 websocket port. |
| C3 | Consumer cutover exams | **Substantially done** (2026-08-09, autonomous run). Ports (in-repo under `ports/`, upstreaming = operator's): **websocket — their conformance suite 55/55 green incl. TLS** via ct-runner + wasi-shims against their real echod; **webcrypto** (11 families — iroh-sufficient; rsa/ecdh/ecdsa/pbkdf2/cipher/key-wrap residual for the bare crypto suite); **webrtc** — their echo-demo component over real data channels (50/50 msgs), send-after-close platform race fixed. **The iroh endpoint exam PASSES 5/5**: bind+identity, relay echo via stock iroh-relay, WebRTC upgrade of a relay-dialed connection (~0.9 s), the jco#11/#13 rows as executable assertions (40 export calls against live detached pumps; accept parked and woken), clean teardown — zero `wasi:sockets` calls (browser profile, fail-on-call stubs). Found IROH-1 (guest borrow across `block_on` yield — `upstream-consumer-findings.md`). Residuals: experiment-mosh composed-client legs (jco#14's row) — browser half rides M3; webcrypto family completion; UDP direct path. |
| P1 | Perf track (post-success) | generated-JS host-boundary executor (differential-tested vs interpreter); deploy-time unbundled layout |

Consumer-track ordering: C0–C3 interleave with M3 — browser packaging
(M3's first half) is on the consumer critical path and is pulled forward
accordingly; the 🧵 and pin-drift residues are not. Every consumer guest is
callback-ABI (wit-bindgen Rust and componentize-go alike) — the path that
needs no JSPI — so the effective engine floor for consumer workloads
relaxes to "any modern engine" (JSPI remains required only for
sync-blocking forms), which is what opens Firefox/Safari-stable legs their
JSPI-only jco path cannot reach.

JSPI engine-variance smoke tests (Firefox pref build, WebKit STP) start
during M2, not M3 — engine bugs in the newest JSPI implementations are a
schedule risk best discovered while the suspension machinery is being
written, not after it is declared done.

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `wasmtime-environ`/FACT won't build or isn't usable on wasm32 | high (gates the architecture) | Spike 0 first; fallback: vendor FACT, drive `wasmparser` directly |
| wasmtime internal API churn | medium, recurring | shim isolation + version pinning; upgrades are deliberate events |
| JSPI phase-4 drift | medium | small trampoline surface, centralized; track proposal |
| Safari: JSPI in STP only; Firefox: flagged | accepted | floor is explicit; stable-Safari exclusion documented |
| JSC/SpiderMonkey JSPI engine bugs | medium | Deno-first dev; file upstream; best-effort WebKit CI lane |
| 0.3 concurrency scope | high | it is the critical path — resourced first, not deferred; task-model-first runtime; callback ABI before JSPI paths; `definitions.py` as executable reference; M2 gated on official `test/async` |
| wasmtime CM-async maturity (feature flags, FACT async gaps) | medium | verified in S0 on a toy async component; pinned versions; gaps contained in the shim (worst case: extend vendored FACT) |
| Testing wasmtime-with-wasmtime blind spots | medium | official suite + definitions.py ports as independent checks |
| Testing-toolchain format skew: testgen assembles with `wast` 255 while the shim validates with wasmparser 0.252 (wasmtime-47 pin) — the 0.253–0.255 window re-arited 🧵 thread opcodes (byte-level desync, see `trap-if-block-and-sync` xfail) | low, bounded | known 5-entry xfail set; exits on the next wasmtime bump; testgen cannot downgrade (suite text syntax needs `wast` ≥255) |
| CSP variance in embedders | low | baseline needs only `wasm-unsafe-eval`; JS codegen is optional |
| Consumer coupling churn: 7+ downstream repos tracking pre-1.0 plan/contract formats | medium | versioned releases from the start of the consumer track; strict formatVersion equality already fails loud; consumer matrices as release gate (the wasmtime↔embedder relationship); both sides already practice exact pinning |
| Consumer scope creep pulling WASI implementations into the core | medium | shim package is a separate deliverable with consumer-driven scope; §2 non-goal stands; the L3 runner lives in polymorph-test, not here |
| Host-boundary perf vs jco's generated JS (v1 interpreter); translator throughput on multi-MB components | low-medium | measured at C0 (translation) and C3 (cutover benches: webcrypto call-heavy, webrtc stream-heavy); §8's generated-JS executor is the designed escape hatch; iroh's polling-workaround removal dominates first-consumer numbers regardless |

## 15. Development protocol (multi-agent)

Work is parallelized across model-pinned subagents defined in the operator's
**global** opencode config (`~/.config/opencode/agent/`; `explore` pinned in
the global `opencode.jsonc`) — deliberately not vendored into this repo, so
all repo-specific context (contracts, spec authorities, gates) travels in
each dispatch prompt. The premise: this repo has unusually dense objective
gates (official suite, `definitions.py` ports, roundtrip fixtures,
differential oracles), which is what makes cheap-model implementation safe.

| Agent | Model | Role |
|---|---|---|
| orchestrator (primary session) | fable | planning, contracts, dispatch, integration, review, **all commits** |
| `coder` | sonnet | implementation tracks against pinned contracts |
| `coder-hard` | opus | subtle tracks: shim internals, CABI edge cases, scheduler periphery |
| `reviewer` | fable | parallel code review when the orchestrator is the bottleneck |
| `explore` | haiku | fast read-only codebase search |

Dispatch rules:

- Every track prompt names: **territory** (paths owned), **governing
  contracts** (`contracts/*.md` + PLAN sections), and **gates** (exact
  commands). Territories are disjoint across concurrent tracks.
- `contracts/` changes are versioned events made only by the orchestrator;
  subagents report contract friction, never edit around it.
- Subagents never commit (permission-enforced); the orchestrator commits
  after review.
- The M2 task-scheduler **core** is single-owner (§6 coherence risk):
  `coder-hard` at most, under close orchestrator review; parallelism stays at
  the periphery.

Review protocol: every track is reviewed against its contracts before commit
— by the orchestrator inline, or by `reviewer` subagents in parallel. A
review dispatch **must** name the diff scope, the governing `contracts/*.md`,
and — for anything touching CABI/async semantics — PLAN §5–§7 plus the spec
sources (`definitions.py` as tie-breaker): the generic reviewer judges only
against named authorities and flags unnamed ones rather than filling gaps
from memory.
Revision rounds go back to the *same* coder session via `task_id` (context
intact), not a fresh agent.

Failure recovery (content-filter false positives, driver interrupts): an
aborted `task` call kills neither the child session (context persists in the
opencode db) nor its effects (files/commands persist on disk). Ladder:

1. Locate the orphan (`opencode-agent-sessions <parent-session-id>`, on
   PATH); resume via `task_id` — "summarize status, then continue".
2. Two failed resumes → assume poisoned context: fresh agent, handoff prompt
   = original track + "partial work exists, audit state first" + artifact
   pointers. Gates arbitrate what's already done (the agents' audit-first
   rule exists for exactly this).
3. Repeated failures across fresh contexts → escalate to the human; the
   trigger may live in the artifacts themselves.

Standing rule: after any fan-out, reconcile launched-vs-completed before
proceeding — a missing result is not missing work. Monitoring asymmetry: the
orchestrator monitors its children, but nothing in-band can monitor the
orchestrator's own aborted turns; that layer belongs to the human/driver.

## 16. Open questions

- Scheduler determinism policy (§6): **DECIDED (M2)** — deterministic FIFO
  ready-queue by default; seeded-shuffle mode via `CE_SCHED_SEED` env var
  exercises spec-allowed nondeterminism in tests (verified across seeds).
  Documented at `runtime/src/task/scheduler.ts`.
- Plan encoding: JSON vs postcard vs custom section inside a wasm container.
  (Decide at M0; deterministic + versioned is what matters.)
- Trust boundary: how much does the TS runtime re-validate translated
  artifacts vs trust the (locally-run, content-addressed) translator? Current
  lean: trust local translation; never trust artifacts that didn't come from
  the local cache keyed by component hash.
- How dtors triggered by `FinalizationRegistry` interact with instance
  teardown ordering (backstop-only by design, but the ordering rules need a
  written policy before M1).
- memory64 components, shared-everything threads (🧵), and other gated
  features: explicitly deferred; revisit when wasmtime ships them by default.
- Node as an officially supported target: **not a consumer requirement.**
  Deno functionally substitutes across the consumer capability surface —
  WebRTC verified empirically (2026-08-08, Deno 2.9.5/linux-arm64,
  `tools/probes/webrtc-deno/`): `node-datachannel` (the polymorph Node
  legs' exact dependency) loads as a Node-API addon under Deno and passes
  a full data-channel loopback, and `werift` (pure TS) passes the same
  probe as the no-native-code fallback; WebSocket/WebCrypto are built-ins;
  UDP/TCP via `Deno.listenDatagram`/node compat. Node stays a nearly-free
  *distribution* target via npm (the callback-ABI path needs no JSPI
  flag), not a CI lane, until someone needs it.
- Embedder conventions (C1): **DECIDED** — all sub-questions (error model,
  stream wrappers, p2 pollable strategy, option nesting, per-interface vs
  per-world wiring) resolved in `contracts/embedder-api.md` v0.1; see the
  C1 milestone row for the decision summary.
- Re-examine the `runtime/src/jspi/bridge.ts:349-394` exclusivity
  divergence (a RESOLVED task that blocks mid-frame releases
  `inst.exclusiveThread`; documented as wasmtime-tracking, but
  `definitions.py` `canon_lift` holds the slot for the callback loop's
  whole life). First real-consumer collision: it widens the window for
  polymorph-iroh's guest-side borrow-across-yield bug
  (`upstream-consumer-findings.md` IROH-1) far beyond wasmtime's observed
  interleaving. The guest is at fault either way, but the divergence now
  has a measured consumer-visible cost — decide keep/narrow with a
  definitions.py-grounded review.

## 17. Adoption: the polymorph consumer track

The first production consumers are the [polymorph-components] family —
`polymorph-{webcrypto,websocket,webrtc-datachannels,tls,test,iroh}` — and
experiment-mosh (a mosh client/proxy tunneled over the iroh endpoint
component). All run the same triangle {wasmtime host, JS host, in-guest
provider}; the JS host is jco (a pinned fork), and the jco legs are where
their plans are blocked. Replacing jco there is this project's adoption
target (§1); jco-convention compatibility is explicitly not part of it
(§2) — the consumers have no external dependents and port to conventions
designed fresh (C1).

Their jco blockers map one-for-one onto this project's proven strengths:

| Their blocker | Class | Our status |
|---|---|---|
| lann/jco#11 (= polymorph-iroh#10): execution-slot queue serializes task lifetimes — a detached pump task deadlocks every later export call; fix blocked behind further scheduler rearchitecting (jco #30, #31); costs iroh a ~5× handshake-latency polling workaround meanwhile | scheduler | task admission is the reference's `enter_implicit_thread` gate; parked callback-ABI tasks release exclusivity — the tested path |
| lann/jco#13: guest-internal stream wakeups never delivered | scheduler | same-component streams/futures fully green |
| lann/jco#14: composed async cross-component calls fail (`_asyncStartCall` param count) | fused adapters | FACT start-calls green across all four ABI pairings incl. spilled params |
| lann/jco#6/#7: subtask/future cancellation traps | cancellation | cross-component cancellation per reference (and upstream finding CM-3) |
| lann/jco#51: TDZ at import time — emitted trampoline references a resource class above its declaration (trigger: async cross-component call returning `own<resource>` + that resource re-exported in an exported interface) | codegen emission | the defect *class* cannot exist in a runtime linker — nothing is emitted; the minimized `compose-async-tdz` shape joins the corpus as a semantics fixture anyway (C0) |
| componentize-go `[async-lower]` imports: "Missing subtask" / hangs (wasmtime runs the same guests correctly — spec-valid guest, host at fault) | subtask bookkeeping | async-lower per the reference; componentize-go fixtures join the corpus to make the claim executable |

Standing consequences:

- **Co-evolution, not compatibility.** Conventions are designed against
  the consumers' host modules as reference implementations (C1); they
  port; both sides pin exactly and upgrade deliberately.
- **WASI interfaces are design inputs even though implementations stay
  out of core.** The conventions must make wasi p2 idioms (pollables, io
  streams, error-code enums, resource-heavy surfaces) and p3 idioms
  (stream/future-bearing signatures, async resource methods,
  error-context) natural to implement in JS — whoever adopts this host
  writes shims against these conventions, and the broader ecosystem's
  most important interfaces are exactly these. C1 exits with paper
  signatures for a representative WASI slice; the C2 shim package is the
  executable check.
- **Their suites become our gates.** This family surfaced at least five
  distinct jco defect classes that no WAST corpus expresses (long-lived
  composed workloads, background pumps, cross-task wakeups, codegen-shape
  triggers). The polymorph matrices and experiment-mosh gates run as
  release gates once C2 lands — necessary-not-sufficient discipline
  applied to ourselves.
- **What replacing jco does not replace**: componentize-js/-go (guest
  production — out of scope per §2; their output components are ordinary
  inputs to us) and the wasmtime host legs (the native story).
- **Unlocks on their side, recorded for the cutover argument**: no
  transpile step, generated trees, flag-verification scripts, or fork
  pins; the Node 24 + JSPI-flag lane replaced by a flagless Deno lane
  (WebRTC included — verified, §16) and, at M3, browser legs beyond
  Chromium; fresh-instance-per-case without re-transpile (their runners
  re-instantiate after poisoning); waker-based cross-task wakeups
  restoring the polling-workaround latency.

[polymorph-components]: https://github.com/polymorph-components

## 18. References

Canonical links future contributors (human or agent) are likely to need.
Versioned links are pinned to the versions this repo pins; re-pin them
together with the dependency.

### Component Model spec (submodule: `third_party/component-model`)

- Explainer (text format, grammar, validation):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md
- Canonical ABI (lift/lower, options, built-ins, invariants):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md
- **Executable CABI reference** (the tie-breaking authority for runtime
  semantics):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/canonical-abi/definitions.py
  — with `run_tests.py` and `diff.py` alongside
- Binary format: https://github.com/WebAssembly/component-model/blob/main/design/mvp/Binary.md
- Concurrency model (0.3 tasks/streams/futures):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/Concurrency.md
- WIT: https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md
- Shared-nothing linking: https://github.com/WebAssembly/component-model/blob/main/design/mvp/Linking.md
- Official WAST suite: https://github.com/WebAssembly/component-model/tree/main/test
- User-facing CM documentation: https://component-model.bytecodealliance.org/
- Our upstream findings tracker: [upstream-component-model-repo-findings.md](upstream-component-model-repo-findings.md)

### JSPI and engine support

- JSPI proposal Overview (the frame rule lives in "Restriction"):
  https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md
- V8 JSPI introduction: https://v8.dev/blog/jspi
- Engine feature matrix: https://webassembly.org/features/ (data:
  https://github.com/WebAssembly/website/blob/main/features.json)
- V8 wasm code caching (the URL/HTTP-cache anchoring facts in §10):
  https://v8.dev/blog/wasm-code-caching
- Stack-switching proposal (JSPI's core-wasm sibling, context only):
  https://github.com/WebAssembly/stack-switching

### wasmtime internals (pinned: wasmtime-environ **47.0.3**)

- API docs: https://docs.rs/wasmtime-environ/47.0.3/wasmtime_environ/
  — notably `component::{Translator, Component, GlobalInitializer, CoreDef,
  Trampoline, CanonicalOptions}` and `fact::Import`
- Source at the pinned tag:
  https://github.com/bytecodealliance/wasmtime/tree/v47.0.3/crates/environ/src
  — FACT: `src/fact.rs` (+ `src/fact/`), component translation:
  `src/component/`
- FACT design note ("polyfill for the component model in JS environments" is
  an intended consumer):
  https://github.com/bytecodealliance/wasmtime/blob/v47.0.3/crates/environ/src/component/translate/adapt.rs
- Wasmtime component wast tests (supplementary corpus):
  https://github.com/bytecodealliance/wasmtime/tree/main/tests/misc_testsuite/component-model

### Toolchain crates (pinned versions in lockfiles)

- wasm-tools repo (CLI + crates): https://github.com/bytecodealliance/wasm-tools
- `wast` crate (component-aware wast parsing, used by testgen):
  https://docs.rs/wast/
- `wasmparser` (0.252.x — must match wasmtime-environ): https://docs.rs/wasmparser/
- `wasm-encoder`: https://docs.rs/wasm-encoder/
- `wit-parser` (bindgen input): https://docs.rs/wit-parser/
- wit-bindgen (guest toolchain, pinned **0.60.0**):
  https://github.com/bytecodealliance/wit-bindgen — `generate!` macro docs:
  https://docs.rs/wit-bindgen/0.60.0/wit_bindgen/macro.generate.html
- wit-bindgen runtime tests (compat corpus):
  https://github.com/bytecodealliance/wit-bindgen/tree/main/tests

### JS platform specifics

- WebIDL `USVString` conversion (our string-lowering semantics):
  https://webidl.spec.whatwg.org/#idl-USVString
- `String.prototype.toWellFormed` (ES2024):
  https://tc39.es/ecma262/#sec-string.prototype.towellformed
- `TextEncoder.encodeInto`:
  https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder/encodeInto
- `TextDecoder` labels (note: "latin1" label decodes windows-1252, hence the
  hand-rolled latin1 in `runtime/src/cabi/strings.ts`):
  https://encoding.spec.whatwg.org/#names-and-labels
- `FinalizationRegistry` (resource backstop — read the caveats):
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry
- Explicit resource management / `using` (TS 5.2+, `Symbol.dispose`):
  https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html
- WebAssembly JS API spec: https://webassembly.github.io/spec/js-api/
- Deno runtime docs (workspaces, `deno test`, `--v8-flags`):
  https://docs.deno.com/runtime/

[WebAssembly/component-model]: https://github.com/WebAssembly/component-model
[CanonicalABI.md]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md
[js-promise-integration Overview]: https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md
