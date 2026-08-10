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

## CM-4: async-lower entry timing — definitions.py decides STARTING eagerly where wasmtime defers

**Status:** DRAFT — candidate upstream issue against `definitions.py`.
**Working assumption** (operator decision, 2026-08-10, **superseding the
2026-08-09 adoption of the release rule**): deltic proceeds on
**wasmtime's actual model — hold rule + deferred entry decision** — as
the expected upstream resolution. Gate lifetime: whole core invocation
(wasmtime and the reference already agree). Entry status: an
async-lowered call reports STARTING only if the callee is still unstarted
after the instance's runnable work is drained to quiescence. deltic's
former release-at-resolution rule was removed the same day — the runtime
now implements the corrected model
([#43](https://github.com/lann/deltic/issues/43); `Store.hasRunnableWork`
+ `createAsyncStartCall`, pinned by
`runtime/tests/entry_deferral_test.ts`). Flip-back trigger:
upstream adjudicating otherwise.
**Found:** 2026-08-08, during the JSPI flip (M2 exit; `sync-streams.wast:208` is the arbiter).
**Corrected:** 2026-08-10 — the original evidence section
mischaracterized wasmtime (claimed its gate ends at resolution; it does
not). Full corrected mechanism:
`exams/wasmtime-exclusivity/wasmtime-actual-semantics.md` (source line
refs for main and v47.0.3 + runtime trace).

### Evidence (corrected 2026-08-10)

- `definitions.py` gates instance entry on `exclusive_thread`, held for
  the whole activation; `canon_lower`'s async path starts the callee
  **eagerly, inline**, so the STARTING/STARTED status reflects the call
  instant — while a resolved-but-ready holder is still parked, the caller
  gets STARTING.
- wasmtime (main, identically v47.0.3) holds
  `ConcurrentInstanceState.do_not_enter` for the **same lifetime** (each
  core invocation: enter/exit_instance at concurrent.rs:2004–2021
  [v47: :1998/:2008], bracketing callback initial invocations
  :2652/:2662, sync-lift invocations :2696/:2714 with the stackful
  exemption, and each callback invocation :942/:960; `task_return` never
  touches it). What differs is **timing**: `start_call`
  (:3040–3160) queues the callee and suspends the caller until the first
  status event; a gated callee yields a `Status::Starting` event and
  parks pending (:1497–1522). Ready gate-holders queued ahead of the call
  run to invocation exit first. Trace proof:
  `exams/wasmtime-exclusivity/trace-sync-streams-wasmtime-dev.log` —
  `$C.get` is resumed, exited, and *deleted* before `$C.set`'s readiness
  is ever evaluated.
- The official suite (`sync-streams.wast:145`) therefore does **not** pin
  release-at-resolution; it rules out exactly the reference's
  hold+**eager** combination. It is satisfied by wasmtime's
  hold+deferred, and also by release+eager (deltic's current rule).
- The reference's own unit tests (`test_callback_interleaving`, both
  hold-encoding sites) are **consistent with wasmtime** — no unit-test
  collateral in a wasmtime-aligned fix.

### Why wasmtime looks right

The reference reports "not started" about a state whose only obstacle is
a holder that is already unblocked and merely unscheduled — a scheduling
artifact surfaced as ABI-visible status. The deferred rule reports the
status of a settled state, preserves every existing unit-test
expectation, and keeps Invariant #3 (single-shadow-stack LIFO) airtight
with no carve-out, since no same-instance execution is ever admitted
while any invocation has live frames parked. (The previously-argued
"producer becomes an accidental instance-wide mutex" liveness cost of the
hold rule is real but bounded: the deferral ends at the producer's
invocation exit, and the flagship + suite accept it.)

### Suggested change

Defer `canon_lower`'s async-path entry decision: report STARTING only if
the callee remains unstarted after the instance's runnable work is
exhausted (drain to quiescence — order-robust, unlike wasmtime's own
FIFO-dependent formulation). `exclusive_thread` lifetime, the callback
event loop, and the entire unit-test corpus stay untouched. Sketch:
`exams/wasmtime-exclusivity/spec-amendment.md`.

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
- **wasmtime's pass is deterministic — but the 2026-08-09 mechanism
  attribution was wrong (corrected 2026-08-10).** Empirically: 50/50
  identical passes under wasmtime 49.0.0-dev (3ebfbe5af, 2026-08-07) with
  `-W component-model-async=y -W component-model-more-async-builtins=y`;
  reconfirmed with trace on a276ccbe1 (2026-08-10). Mechanically the
  determinism rests on **deferred entry + FIFO order + the producer's
  readiness preceding the `set` lower** (the ready `$C.get` runs to exit
  before `$C.set`'s readiness is evaluated), *not* on a gating rule that
  ends at resolution — see
  `exams/wasmtime-exclusivity/wasmtime-actual-semantics.md`.
  (Vintage note: the wasmtime 47.0.1 *release* CLI cannot even parse the
  current suite text — its bundled wast crate predates the 2026-07 #655
  syntax adherence pass — so any 47-era corroboration must use the crate
  APIs or a dev build.)

Net: the filing should present this as an internal spec-repo inconsistency
(reference vs its own test corpus) that only external implementations can
currently observe, propose the **entry-timing fix** (defer the async-lower
status decision; gate lifetime untouched), and suggest the structural fix
— run the wast suite against the reference (or at least flag
reference-affecting suite assertions) in the spec repo's own CI.

### Filing artifacts (2026-08-09 set, re-scoped by the 2026-08-10 correction)

- **`exams/wasmtime-exclusivity/wasmtime-actual-semantics.md`** +
  **`trace-sync-streams-wasmtime-dev.log`** — THE wasmtime-side evidence:
  gate lifetime from source (main + v47.0.3 line refs, all
  `do_not_enter` sites), deferred-entry mechanism, and the runtime trace
  showing `$C.get` exits before `$C.set` is admitted.
- **`exams/wasmtime-exclusivity/cm4-run-tests.patch`** — adds
  `test_resolved_task_gates_entry` to the reference's own `run_tests.py`.
  Still valid as the reference-side contradiction demo (fails against
  pristine `definitions.py` at the STARTING assertion). **Caveat:** its
  shared-state assertions (`poke_saw == 1`, `pump_observed == 2`) encode
  the *release rule*, not wasmtime's semantics — under hold+deferred the
  interloper is admitted only after the holder exits. A wasmtime-aligned
  filing should trim it to the STARTING/RETURNED skeleton or re-derive
  expectations.
- **`exams/wasmtime-exclusivity/cm4-reference-fix.patch`** — the
  release-rule experiment (3 hunks). **No longer the proposed fix**; kept
  as the demonstration that release+eager also satisfies the wast corpus
  and of its cost (breaks `test_callback_interleaving`, whose second
  progress-free window and STARTING tail encode hold semantics — full
  trace in `root-cause.md`). The wasmtime-aligned fix touches
  `canon_lower` timing instead and has zero unit-test collateral.
- **`exams/wasmtime-exclusivity/verify-cm4.sh`** — legs 0–1 (stock pass;
  new test fails pristine) remain the contradiction repro; legs 2–3
  document the release-rule experiment's behavior. Note the reference
  harness hangs after any failing assertion (non-daemon threads) — run
  under `timeout`, judge by traceback.
- **`exams/wasmtime-exclusivity/spec-amendment.md`** — the amendment
  sketch, rewritten 2026-08-10 for the corrected model: deferred entry
  decision, no gate-lifetime change, no Invariant #3 carve-out, no
  unit-test rewrites; order-robust drain-to-quiescence formulation.

Net-net for the filing: `definitions.py` and the repo's wast suite
disagree about **when the async-lower entry status is decided** (eager
instant vs after-drain); wasmtime implements (and its CI deterministically
validates) the deferred side with an invocation-lifetime gate identical to
the reference's; nothing upstream validates the reference against the wast
corpus; the artifacts above make all of this reproducible.

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
