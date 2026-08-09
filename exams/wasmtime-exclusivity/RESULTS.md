# wasmtime exclusivity check — is the sync-streams pass deterministic?

Evidence backing `upstream-component-model-repo-findings.md` CM-4's
2026-08-09 review and the IROH-1 consumer finding. Question posed by the
operator: wasmtime runs the official CM test suite — is *its* pass on the
CM-4 arbiter (`test/async/sync-streams.wast`) itself scheduling accident?

**Answer: no — deterministic semantics.** A custom counter-experiment wast
was planned and then dropped as redundant: the official test already
contains the full IROH-1 shape, and wasmtime's pass on it is deterministic
by construction and by measurement.

## What the official test already demonstrates

`test/async/sync-streams.wast` (spec repo, e8d8005 vintage and current):

1. `$C.get` calls `task.return` (RESOLVED) and then parks **mid-frame** in a
   synchronous `stream.write` (first to the rendezvous).
2. `$D.run` — sync-lowered, so it regains control at `get`'s *resolution*,
   while `get`'s thread is still parked — rendezvous-reads, then calls
   `$C.set` **without ever yielding in between** (straight-line core wasm).
3. Line 145 asserts `set` reports **STARTED**: the same-instance task was
   admitted, and its body *executed* (it runs its own `stream.read` and
   memory traffic — clobbering address 16, which `get`'s parked frame also
   uses — before blocking). Under `definitions.py`'s `exclusive_thread`
   lifetime, `set` would be gated (STARTING) and the guest traps
   `unreachable` at line 146.

That is: entry admitted + interloper body run + shared state mutated, all
while a resolved task sits parked mid-frame — the IROH-1 collision shape,
in the official corpus, asserted as the *expected* behavior.

## Why the pass is deterministic (structure)

Between the rendezvous read and the `set` call, `$D.run` executes
straight-line wasm with no suspension point; execution is single-threaded
and cooperative. The machine state at the entry-gate check is therefore a
pure function of the program, and STARTED-vs-gated is decided solely by the
gating rule (wasmtime: `ConcurrentInstanceState.do_not_enter`, scoped to
the sync-call span, ending at resolution). No race exists at the arbiter.

## Measurement

wasmtime 49.0.0-dev (`3ebfbe5af`, 2026-08-07 — a current-main dev release;
the 47.0.1 release CLI cannot parse the post-#655 suite syntax):

```sh
./run.sh   # fetches nothing; expects `wasmtime` ≥ the 2026-07 suite syntax on PATH
```

Result: **50/50 identical silent passes** (exit 0) of
`third_party/component-model/test/async/sync-streams.wast` with
`-W component-model-async=y -W component-model-more-async-builtins=y`.

deltic's own lane passes the same file deterministically (green under
`DELTIC_SCHED_SEED=1` and `=4242`; see `harness/src/xfail.ts`'s
sync-streams note and CI).

## CI provenance (who actually runs this suite)

- The spec repo's CI runs **only** `design/mvp/canonical-abi/run_tests.py`
  — the wast suite is never executed against the reference.
- wasmtime vendors the spec repo as the `tests/component-model` submodule
  (bumped to e8d8005 on 2026-07-24, commit b6cb744) and runs the suite in
  CI with an explicit exception ledger; `sync-streams.wast` is not on it.

So the reference↔suite contradiction (CM-4) has no upstream detector: each
CI is green against its own half.

## The one true "scheduling accident" in the story

Downstream only: the *semantics* (suite-pinned, wasmtime-implemented,
deltic-implemented) **admit** same-instance task execution during a
resolved task's mid-frame block; whether an admitted interleaving lands on
a *colliding* point (polymorph-iroh's `RefCell` window, IROH-1) is a
scheduler choice — deterministic per host, guaranteed by nothing. wasmtime's
endpoint-matrix green and deltic's ~90% trap rate are the same semantics
under different deterministic schedules.
