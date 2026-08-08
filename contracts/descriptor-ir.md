# Contract: CABI Descriptor IR v0

The **descriptor IR** is the type/options information that drives host-boundary
lift/lower — PLAN.md §8's "one IR, two executors." Producers: the translator
shim (inside `plan.json` `types` / `canonicalOptions` tables) and tests.
Consumers: the v1 interpreter (`runtime/src/cabi/`), the future generated-JS
executor, and the world-digest computation.

Status: **v0.1** (v0 amended post-M0). The normative in-memory
model is `runtime/src/cabi/types.ts`; this document defines its meaning and
its JSON wire form inside the plan. Known wire↔memory divergences are pinned
in "v0.1 amendments"; any other divergence is a bug.

## Value type model

A `ValType` is a discriminated union (JSON: `{ "kind": … }` objects, nested
structurally). Kinds:

- Primitives: `bool`, `s8`, `u8`, `s16`, `u16`, `s32`, `u32`, `s64`, `u64`,
  `f32`, `f64`, `char`, `string`
- `list` (`element`, optional fixed `length`), `record` (`fields`:
  `{label, type}[]`), `tuple` (`elements`), `variant` (`cases`:
  `{label, type|null}[]`), `enum` (`labels`), `option` (`type`),
  `result` (`ok|null`, `err|null`), `flags` (`labels`)
- Handles: `own` / `borrow` (`resource`: index into the plan's resource table)
- Async: `stream` / `future` (`element|null`), `error-context`

Specialized forms are preserved (tuple/enum/option/result/flags are not
pre-despecialized in the IR); `despecialize` is defined once, in the runtime,
mirroring `definitions.py`. Labels remain strings in v0 (interning is a
measured-need optimization).

`FuncType` is `{ params: {label, type}[], results: ValType[], async?: bool }`.

## Canonical options

Per lifted/lowered function, referencing plan tables by index (see
plan-format.md): `stringEncoding` (`utf8` | `utf16` | `latin1+utf16`),
`memory?`, `realloc?`, `postReturn?`, `callback?`, `async`, `cancellable`,
and the expected flat `coreType` (`{params, results}` of `i32|i64|f32|f64`).
This mirrors `wasmtime_environ::component::CanonicalOptions` minus
runtime-irrelevant fields; `data_model` is fixed to linear memory in v0 (GC
data model is rejected by the shim).

## Flattening

The plan does **not** precompute flat lane lists. Executors compute flattening
from `ValType` via the shared rules in `runtime/src/cabi/flatten.ts`, which is
tested against fixtures generated from `definitions.py` (`flatten_functype`,
MAX_FLAT_PARAMS=16, MAX_FLAT_RESULTS=1, async variants with their own
limits, spill-to-memory rules). Rationale: one implementation of the trickiest
rules, differentially anchored to the executable spec; smaller plans; less
shim logic. The consistency check between computed flattening and the
options' `coreType` is an instantiate-time assertion. (Precomputed lanes can
be added later as a pure optimization without changing this contract's
semantics.)

## Host value mapping (target — normative at M1)

**Status note (v0.1):** this table is the *bindgen-era target*, normative
once the M1 boundary layer lands. The v1 interpreter currently produces the
`definitions.py` shapes (variant as single-key `{label: payload}`, enum as
`{label: null}`, option as `{none: null} / {some: v}`, result error key
`"error"`, tuple as despecialized record) and the M0 e2e tests lock those.
Convergence is scheduled with bindgen; until then the interpreter shapes are
the implementation truth and this table is the destination.

| Component type | JS value |
|---|---|
| bool | `boolean` |
| s8..u32, f32, f64, char (as code point) | `number` |
| s64/u64 | `bigint` (range-checked at lower) |
| string | `string`; lowering applies USVString replacement (`toWellFormed`) |
| list<u8> | `Uint8Array` (always a copy, never a view into guest memory) |
| other lists / tuples | `Array` |
| record | plain object keyed by label |
| variant | `{ tag: label, val?: … }` single-tag object |
| enum | label `string` |
| option<T> | `undefined \| T`; nested options use `{ some: … } / null` shape per types.ts |
| result | `{ ok: … } \| { err: … }` |
| flags | object of `boolean`s keyed by label |
| own/borrow | runtime handle class (bindgen wraps in resource classes) |
| stream/future/error-context | runtime task-core objects (M2) |

NaN handling, lane widening/padding (i64 lanes as `bigint`, `0n` padding),
and latin1(windows-1252) details follow the decisions recorded in
`runtime/README.md` and PLAN.md §7.

## Trap discipline

Lift/lower failures raise the runtime's `ComponentTrap` (not arbitrary
`Error`s), with the trap conditions of `definitions.py` (`trap_if`) as the
authority. Executors must produce the same trap/no-trap verdict for the same
inputs — this is part of the differential-testing contract.

## Executor contract

Interpreter (v1) and generated-JS (P1) executors consume this IR unchanged;
the differential test harness runs both over the same fixture corpus
(`runtime/tests/fixtures/`, regenerable from the Python reference). Any IR
extension must land with fixtures.

## Open items (v0)

- Resource-type representation: the shim emits `resource` indices into the
  plan's `resourceTables`; the runtime builds identity tokens
  (`ResourceTypeInfo`) at plan-load time. **Pinned in v0.1: tokens must be
  fresh per instantiation** (the executor re-runs plan loading per
  instantiate), so resource-type identity never leaks across instances.
- Variant/option host shapes are settled for the interpreter but bindgen (§9)
  may want ergonomic variations — any change lands here first.
- `map` (in types.ts, from the reference) is not emitted by current
  translators; keep behind a fixture-only flag.

## v0.1 amendments (post-M0 reality)

1. **Wire naming pinned where it diverges from types.ts** (the plan loader
   maps): wire `result.err` ↔ types.ts `result.error`; wire `FuncType.params`
   are labeled `{label, type}[]` while types.ts drops names (this resolves
   the runtime README's open question: names live on the wire and in bindgen,
   not in the interpreter's hot path).
2. **Flattening contract validated as written**: computed `flattenFunctype`
   vs the options' `coreType` asserted at instantiate across the whole
   fixture corpus with zero mismatches. No change.
