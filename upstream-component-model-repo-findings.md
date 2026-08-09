# Upstream findings: WebAssembly/component-model

Single source of truth for issues and PRs we file (or intend to file) against
the [WebAssembly/component-model] repository. Anything upstream-worthy
discovered during development gets an entry **here**, not a note in the design
docs — docs/architecture.md links here instead. Findings against *other* repos (wasm-tools,
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
  side by owning the emitter (`crates/testgen`, docs/architecture.md §11). Only worth
  upstream traffic (bytecodealliance/wasm-tools) if still true at a current
  CLI release.
- **wasmparser 0.252 requires async function types for async lifts; wasm-tools
  1.247's validator predates the rule**: spec-tracking drift between released
  versions, not a component-model repo defect. Handled by docs/architecture.md §4.1/§9
  version-pinning discipline (the translator's wasmparser is the single
  validation authority).

[WebAssembly/component-model]: https://github.com/WebAssembly/component-model

## CM-3: `cancel_copy` returns a stale COMPLETED where wasmtime reports CANCELLED

**Status:** DRAFT — candidate upstream issue/PR against `definitions.py`
**Found:** 2026-08-08, implementing the stream copy protocol (M2 phase 2c review)

### Evidence

`definitions.py` `cancel_copy` (line 2652):

```python
e.state = CopyState.CANCELLING_COPY
if not e.has_pending_event():
    e.shared.cancel()
    ...
code,index,payload = e.get_pending_event()
return [payload]
```

When the end already has an armed-but-**undelivered** event, the pending event
is returned verbatim. For a stream write that was partially satisfied by a
rendezvous, that event is `COMPLETED | (count << 4)` (armed by `on_copy` in
`stream_copy`), so a subsequent `stream.cancel-write` reports COMPLETED.

wasmtime instead supersedes it
(`wasmtime-47.0.3 runtime/component/concurrent/futures_and_streams.rs:4004`):

```rust
match (code, event) {
    (ReturnCode::Completed(count), Event::StreamWrite { .. })
        => ReturnCode::Cancelled(count),
    (ReturnCode::Dropped(_) | ReturnCode::Completed(_), _) => code,
    ...
}
```

i.e. an undelivered **stream** `Completed(count)` becomes `Cancelled(count)`;
`Dropped` is unchanged, and a **future** `Completed` is unchanged.

The official suite asserts wasmtime's answer, not the reference's:
`test/async/big-interleaving-test.wast:1520-1531` writes 8, reads 4, then
cancels the write and expects `0x42` (`CANCELLED | 4<<4`). Under the
reference's rule the answer is `0x40`. The neighbouring test at :1504 does not
disagree — it `poll`s the event first, so the cancel finds nothing pending and
takes the `shared.cancel()` path to CANCELLED either way, which is why only
the no-poll variant exposes the difference.

### Why wasmtime looks right

The guest never observed the completion. Reporting COMPLETED would tell it the
write finished when in fact it was cancelled after copying 4 of 8 elements, and
the count alone cannot distinguish the two.

### Suggested change

In `cancel_copy`, when the pending event is a stream `COMPLETED`, deliver
`CANCELLED` with the same progress count.

---

## CM-4: entry-gating duration — definitions.py's `exclusive_thread` outlives wasmtime's "sync call in progress"

**Status:** DRAFT — candidate upstream issue against `definitions.py`
**Found:** 2026-08-08, during the JSPI flip (M2 exit; `sync-streams.wast:208` is the arbiter)

### Evidence

- `definitions.py` gates instance entry on `exclusive_thread`, held for the
  **whole activation** of a non-reentrant task — a task that has already
  resolved (`task.return` executed) but continues running (the legal
  producer pattern) still blocks new entries until its thread finishes.
- wasmtime 47.0.3 gates on **"a sync call in progress"**
  (`ConcurrentInstanceState.do_not_enter`, concurrent.rs:501, bracketed at
  :1998/:2008, with the stackful-async exemption at :2701): a resolved
  producer blocked mid-sync-write does **not** gate the next entry.
- The official suite asserts wasmtime's semantics: `sync-streams.wast:208`
  expects a STARTED (not blocked-on-entry) result while a resolved producer
  is parked mid-copy.

### Why wasmtime looks right

Post-resolution execution is explicitly legal in 0.3; making it hold the
instance's entry gate turns every producer into an accidental mutex for its
whole (unbounded) background lifetime. The gate's purpose — non-reentrance
of the *call* — ends when the call's synchronous span ends.

### Suggested change

Scope the reference's entry gate to the sync-call-in-progress span (release
on resolution + block), or document the divergence and mark the suite test
as the normative source.

### 2026-08-09 review: not a recent-spec-change lag, and structurally invisible upstream

Reviewed on operator prompt (3-month spec-history window + wasmtime CI
provenance + determinism check; full transcripts in
`exams/wasmtime-exclusivity/RESULTS.md`):

- **Both sides are ancient.** The exclusivity model (`exclusive`, then
  `exclusive_thread`) with the hold-for-the-activation lifetime dates to
  ≥ 2025-08-20 (#553); `sync-streams.wast`'s contrary assertion dates to
  the file's birth, 2025-09-05 (9b5aa62). The in-window commits — #650
  (2026-05-21, `exclusive: Task` → `exclusive_thread: Thread` + the
  entering-set reentrance definition) and #656 (2026-05-29, cooperative
  thread built-ins) — refined granularity without touching the release
  points. This is a ~11-month-old inconsistency, not wasmtime lagging a
  recent change (nor the reverse).
- **No CI cross-checks the two.** The spec repo's CI runs only
  `run_tests.py` (definitions.py's own unit tests); the wast suite is
  never executed against the reference. wasmtime runs the suite via a
  `tests/component-model` submodule (currently e8d8005, bumped 2026-07-24)
  with an explicit exception ledger for known misalignments (e.g.
  `post-return.wast` pending #680 alignment) — `sync-streams.wast` is not
  on it. So: wasmtime CI green, spec CI green, and the reference↔suite
  contradiction has no detector by construction.
- **wasmtime's pass is deterministic, not scheduling accident.**
  Structurally: `$D.run` never yields between the first rendezvous and the
  `$C.set` call, so the entry-gate check occurs at a fully deterministic
  machine state — the STARTED-vs-gated outcome is a pure function of the
  gating rule. Empirically: 50/50 identical passes under wasmtime
  49.0.0-dev (3ebfbe5af, 2026-08-07) with
  `-W component-model-async=y -W component-model-more-async-builtins=y`.
  (Vintage note: the wasmtime 47.0.1 *release* CLI cannot even parse the
  current suite text — its bundled wast crate predates the 2026-07 #655
  syntax adherence pass — so any 47-era corroboration must use the crate
  APIs or a dev build.)

Net: the filing should present this as an internal spec-repo inconsistency
(reference vs its own test corpus) that only external implementations can
currently observe, propose the gate-scoping fix (or normative-source
ruling), and suggest the structural fix — run the wast suite against the
reference (or at least flag reference-affecting suite assertions) in the
spec repo's own CI.

### 2026-08-09 filing artifacts (ready to paste)

- **`exams/wasmtime-exclusivity/cm4-run-tests.patch`** — adds
  `test_resolved_task_gates_entry` to the reference's own `run_tests.py`
  (sync-streams.wast's shape in the file's idiom); fails against pristine
  `definitions.py` at the suite-pinned expectation (STARTING observed
  where the wast suite demands admission). THE demonstration diff.
- **`exams/wasmtime-exclusivity/cm4-reference-fix.patch`** — the
  resolution-scoped gate transplanted into `definitions.py` (3 hunks:
  release at block for resolved holders; only-if-holder releases;
  held-guarded callback-loop release/retake). Verdict: makes the new test
  pass, and reveals the **second contradiction** — the reference's own
  `test_callback_interleaving` fails, because its second progress-free
  poll window *encodes* the hold-semantics (the gated producer is
  admitted and completes inside the window once the resolved producer's
  post-resolution sync `future_read` stops holding the slot; full trace
  in `exams/wasmtime-exclusivity/root-cause.md`). Any spec-side fix must
  also rewrite that window. Shipped as a demonstration, not
  ready-to-merge.
- **`exams/wasmtime-exclusivity/verify-cm4.sh`** — reproduces all four
  legs from pristine copies. Note the reference harness hangs after any
  failing assertion (non-daemon threads; pre-existing, reproducible by
  injecting `assert(False)` into stock `test_async_backpressure`) — run
  under `timeout`, judge by traceback.
- **`exams/wasmtime-exclusivity/spec-amendment.md`** — plain-language
  sketch of the amendment itself: why the release-at-resolution rule
  should win, the five spec-repo artifacts it touches, and the one real
  cost — Invariant #3 (Explainer.md:3007–3011) needs its serialization
  promise scoped to pre-resolution execution, a toolchain-visible carve-out
  the other filing artifacts don't call out. Also records the authorship
  fact (both corpora are Luke Wagner's; the wast side is the newer vintage).

Net-net for the filing: definitions.py's unit tests and the repo's wast
suite pin **opposite** entry-gating semantics for resolved tasks;
wasmtime implements (and its CI deterministically validates) the wast
side; nothing validates the other; the two patches above make both facts
reproducible inside the spec repo itself.

---

## NOTE-1: several official async tests assume the deterministic profile

**Status:** NOTE (documentation candidate, not a defect)
**Found:** 2026-08-08 (`async-calls-sync.wast` run-cb, M2 seeded-scheduling
investigation)

`async-calls-sync.wast`'s guest asserts each subtask's returned value equals
its index — an order pinned only by `DETERMINISTIC_PROFILE`
(definitions.py:1373): when backpressure clears, all waiters become ready at
once and the reference's `Store.tick` picks with `random.choice`. A host
exploring the spec's allowed nondeterminism beyond the deterministic profile
fails the guest's own assertion. Worth an upstream doc note on `test/async`
(tests assume the deterministic profile) or making the guests
order-tolerant. Hosts adding seeded-schedule testing should profile-scope
pins for such fixtures (we did).
