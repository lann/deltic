# CM-4: how and why the spec would be amended (plain-language sketch)

Companion to `RESULTS.md` (evidence), `root-cause.md` (reference-side
mechanism), and `wasmtime-actual-semantics.md` (wasmtime-side mechanism,
2026-08-10 — which corrected this document's premises; the previous
revision wrongly attributed a release-at-resolution gate to wasmtime).
Line references: spec submodule `73b7ad5`; wasmtime main as of 2026-08-10.

## The contradiction, restated correctly

`test/async/sync-streams.wast:145` requires an async-lowered call to a
same-instance callback-lifted export to report **STARTED** in a state
where the previous task has resolved (`task.return`) but is still parked
mid-frame in a sync builtin — *and is ready to resume*. Pristine
`definitions.py` deterministically reports STARTING there (guest traps at
:146): its `canon_lower` runs the callee **eagerly, inline**, so the
entry check happens at the call instant, while the parked-but-ready
holder still holds `exclusive_thread`.

wasmtime passes — but not by releasing its gate at resolution. Verified
from source and runtime trace (`wasmtime-actual-semantics.md`):

- wasmtime's gate (`ConcurrentInstanceState.do_not_enter`) has the **same
  lifetime** as the reference's `exclusive_thread`: the whole core
  invocation, held across post-return mid-frame parks.
- What differs is **when the entry decision is made**: the call is
  queued, the caller suspends until the first status event, and the
  executor first drains work queued ahead of the call — including the
  ready-to-resume gate holder, which runs to invocation exit and releases
  the gate. Only then is the new call's readiness evaluated: STARTED.
- If the holder is *not* ready (parked on an un-rendezvous'd operation),
  the new call parks as pending and the caller receives **STARTING** —
  hold semantics, observably.

So, in one sentence, the question the repo must adjudicate:

> **When is an async-lowered call's initial status decided — eagerly at
> the call instant (`definitions.py` today), or only after the instance's
> runnable work has been exhausted (wasmtime)?**

Gate lifetime is *not* in dispute between wasmtime and the reference:
both hold to invocation exit. (A third semantics — releasing the gate at
resolution — also satisfies the wast corpus; deltic currently ships it.
See "the release-rule alternative" below.)

## Why the deferred rule should win upstream

1. **It is what ships.** wasmtime implements it; the wast corpus is
   maintained against wasmtime as its documented runner (test/README.md)
   and passes deterministically. Amending the reference changes nothing
   in production.
2. **It preserves every existing unit-test expectation.** Under hold +
   deferred entry, the reference's `test_callback_interleaving` — both
   hold-encoding sites (the :990–995 progress-free window and the
   :1009–1011 STARTING tail) — passes **unchanged**. The amendment
   touches `canon_lower`'s scheduling, not `exclusive_thread`'s
   lifetime, so no existing gate-lifetime semantics move.
3. **It keeps Invariant #3 airtight with no carve-out.** Because the gate
   still spans the whole invocation, no same-instance execution is ever
   admitted while a task (resolved or not) has live frames parked
   mid-block. Single-shadow-stack LIFO discipline (Explainer.md
   :3007–3011) is preserved unconditionally — the producer pattern never
   interleaves with live frames.
4. **The STARTING-at-the-instant answer is arguably a scheduling artifact
   anyway.** The reference reports "not started" about a state in which
   the only obstacle is a holder that is already unblocked and merely
   unscheduled. The deferred rule reports the status of a settled state.

Cost, honestly stated: the deferred rule makes the instance-entry status
depend on scheduler drain order. wasmtime's own pass is FIFO-dependent
(had the new call been evaluated before the ready holder resumed, the
caller would see STARTING and the guest would trap). A spec formulation
should therefore be order-robust, e.g.:

> An async-lowered call reports STARTING only if the callee remains
> unstarted after the instance's runnable work has been exhausted
> (drain to quiescence, not a single scheduling step).

which is deterministic under any fair scheduler, including seeded-shuffle
testing.

## What actually changes (all in the spec repo)

1. `definitions.py` `canon_lower` (async path, :2284+): defer the
   initial-status decision — run/park the callee only after ready threads
   have been given the chance to run to quiescence (the reference's
   cooperative-model equivalent of wasmtime's queued `StartImplicit` +
   caller-waits-for-first-status, concurrent.rs:3040–3160, :1497–1522).
   `exclusive_thread`, `enter_implicit_thread`, and the callback event
   loop are **untouched**.
2. `CanonicalABI.md` — document the deferred entry decision alongside
   `canon_lower`; the :3740–3748 lock-lifetime prose stays as-is (it is
   correct, and wasmtime agrees with it).
3. `run_tests.py` — no changes required; the existing corpus (including
   `test_callback_interleaving`) already encodes hold semantics, which
   survive.
4. `Explainer.md` Invariant #3 — no carve-out needed.

Contrast with the release-rule amendment (previous revision of this
sketch): that path changes `exclusive_thread`'s lifetime (3 hunks),
rewrites `test_callback_interleaving`'s window and tail, and requires a
toolchain-visible Invariant #3 carve-out (post-return code loses the
serialization guarantee at block points). The deferred-entry path
requires none of that. Both reconcile the wast corpus; the deferred path
is the strictly smaller and safer change — and it is the one wasmtime
actually implements.

## The release-rule alternative (deltic's current shipping semantics)

Release-at-resolution + eager start also passes the full official wast
suite (measured under deltic, green under scheduler seeds — it is
order-robust by construction, since the gate is simply open). Its costs:

- Admits same-instance execution *during* a resolved task's mid-frame
  park: live-frame interleaving on the single shadow stack → Invariant #3
  carve-out required; and application-state reentrancy the ecosystem's
  flagship does not exhibit (the IROH-1 collision is reachable under this
  rule and unreachable under wasmtime's — see
  `upstream-consumer-findings.md`).
- Contradicts the reference's own `test_callback_interleaving`, so the
  upstream diff is larger and touches pinned semantics.

Per the 2026-08-10 operator decision, deltic migrates to the wasmtime
model (hold + deferred entry); the release rule is no longer proposed
upstream.

## Why this likely lands (process)

- Both corpora are the same author's work (Luke Wagner: the exclusivity
  model in #553, 2025-08-20; `sync-streams.wast` and fixes from
  2025-09-05). The filing is "your reference's *entry-timing* choice
  contradicts your own suite and your flagship's shipped behavior" — a
  scheduling fix with zero collateral in the unit-test corpus.
- Precedent: CM-3 (`upstream-component-model-repo-findings.md`) resolved
  the same suite+wasmtime-vs-reference triangle in the same direction
  (fix the reference).
- Structural follow-up for the same filing: the spec repo's CI runs only
  `run_tests.py` (main.yml:16); the contradiction stayed invisible for
  ~11 months because no CI runs the wast corpus against the reference.
