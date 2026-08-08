# Upstream findings: WebAssembly/component-model

Single source of truth for issues and PRs we file (or intend to file) against
the [WebAssembly/component-model] repository. Anything upstream-worthy
discovered during development gets an entry **here**, not a note in PLAN.md —
PLAN.md links here instead. Findings against *other* repos (wasm-tools,
wasmtime, wit-bindgen) do not belong in this file; see "Out of scope" at the
bottom.

All file/line references are against the submodule pin at
`third_party/component-model` — currently **`73b7ad5`**. Re-verify line
numbers before filing if the submodule has been bumped.

Status legend: `DRAFT` (not yet filed) → `FILED #n` / `PR #n` → `RESOLVED`.

---

## CM-1: vestigial `$async?` immediate on `canon resource.drop` in CanonicalABI.md

**Status:** DRAFT — proposed as a one-line docs PR
**Found:** 2026-08-08, while answering "are dtors allowed to block?"

### Evidence

- `design/mvp/CanonicalABI.md:4013` shows the canonical-definition template as
  `(canon resource.drop $rt $async? (core func $f))`.
- The Explainer grammar has no async immediate:
  `design/mvp/Explainer.md:1539` — `(canon resource.drop <typeidx> (core func <id>?))`.
- The reference implementation has no async parameter:
  `canonical-abi/definitions.py:2319` — `def canon_resource_drop(rt, i)`,
  hardcoding `CanonicalOptions(async_ = False)` and a sync `FuncType`.
- The prose four paragraphs below the template is explicit that drops are
  synchronous: *"Because the type, lifting and lowering are all non-`async`,
  the destructor may not block."* (CanonicalABI.md ~4046).

Earlier 0.3 drafts had an async variant of `resource.drop`; the `$async?` in
the wat template is a leftover from its removal.

### Proposed fix

Docs PR deleting `$async?` from the template at CanonicalABI.md:4013.

### Draft PR description

> CanonicalABI.md's canonical-definition template for `resource.drop` still
> shows an `$async?` immediate. The Explainer grammar, the validation text,
> and `canon_resource_drop` in definitions.py all define `resource.drop` as
> unconditionally synchronous (and the surrounding prose says "the destructor
> may not block"). This looks like a leftover from the removal of async
> drops; this PR removes the stale immediate from the template.

---

## CM-2: `canon_backpressure_set` is dead code in definitions.py

**Status:** DRAFT — proposed as a PR removing it (with a question in the
description in case retention is intentional)
**Found:** 2026-08-08, during the canonical-ABI reference-test port

### Evidence

- `canonical-abi/definitions.py:2366-2371` contains a
  `### 🔀 canon backpressure.set` section defining
  `canon_backpressure_set(flat_args)`.
- Neither prose document knows it: the CanonicalABI.md TOC and body document
  only `canon backpressure.{inc,dec}` (CanonicalABI.md:46, and the section the
  TOC points to), and the Explainer grammar defines only
  `(canon backpressure.inc ...)` / `(canon backpressure.dec ...)`
  (Explainer.md:1543-1544; prose at 1706).
- Because no grammar production exists, `canon_backpressure_set` is
  **unreachable from any component** — dead code from the
  `backpressure.set` → `backpressure.{inc,dec}` transition.
- The repo's own consistency checker fails on exactly this:
  `python3 canonical-abi/diff.py` reports 4 content differences, all of them
  the `canon_backpressure_set` block (definitions.py:2180-2183 in diff.py's
  code-block numbering vs CanonicalABI.md jumping straight to
  `canon_backpressure_inc`), and exits with
  *"Error: Differences found between definitions.py and CanonicalABI.md."*

### Proposed fix

PR removing the `canon backpressure.set` section from definitions.py, making
`diff.py` pass again. The PR description should ask whether the function was
kept deliberately (e.g., transitional compat for toolchains that emitted
`backpressure.set`) — if so, the alternative fix is documenting it in
CanonicalABI.md and the Explainer instead.

### Draft PR description

> `definitions.py` still defines `canon_backpressure_set`, but the Explainer
> grammar and CanonicalABI.md only define `backpressure.inc`/`backpressure.dec`
> — there is no grammar production that could reach it, and
> `canonical-abi/diff.py` currently fails with this block as its only
> difference. This PR removes the leftover from the set→inc/dec transition.
> If it is being kept intentionally for transitional toolchain compatibility,
> happy to convert this into a docs PR adding it back to the grammar/prose
> instead — but as it stands the repo's own consistency check is red.

---

## Filing checklist (per finding)

1. Re-verify evidence against current `main` (not just our submodule pin).
2. Search existing issues/PRs for duplicates.
3. File; record the number and flip the status line here.
4. On resolution: bump the submodule, note the resolving commit here, and
   remove any workaround/annotation in our code that referenced the finding.

## Out of scope (tracked elsewhere, listed so they aren't lost)

- **wasm-tools CLI 1.247 `json-from-wast` parser lag** (15/59 suite files
  parse; current `wast` crate parses 59/59): version-skew, resolved on our
  side by owning the emitter (`crates/testgen`, PLAN.md §11). Only worth
  upstream traffic (bytecodealliance/wasm-tools) if still true at a current
  CLI release.
- **wasmparser 0.252 requires async function types for async lifts; wasm-tools
  1.247's validator predates the rule**: spec-tracking drift between released
  versions, not a component-model repo defect. Handled by PLAN.md §4.1/§9
  version-pinning discipline (the translator's wasmparser is the single
  validation authority).

[WebAssembly/component-model]: https://github.com/WebAssembly/component-model
