# CM-4 root cause: the reference's unit tests pin the semantics its wast suite contradicts

Companion to `RESULTS.md`; produced while building the filing artifacts
(`cm4-run-tests.patch`, `cm4-reference-fix.patch`). Line numbers are
pristine `run_tests.py` / `definitions.py` at submodule `73b7ad5`.

## The new test (cm4-run-tests.patch)

`test_resolved_task_gates_entry` — the sync-streams.wast shape in
run_tests.py's own idiom: `pump` (async callback lift, `needs_exclusive`)
calls `canon_task_return` then parks mid-frame holding a shared "borrow"
flag; `poke` (same instance) reads and mutates that state; a consumer in
another instance lowers both and asserts the wast suite's expectations
after quiescence.

- Pristine `definitions.py`: fails at
  `assert(poke_state == Subtask.State.RETURNED)` — observed
  `STARTING` + a subtask handle, `poke_saw = None` (never admitted): the
  CM-4 divergence, exactly.
- With `cm4-reference-fix.patch` applied: passes (3/3 runs), and the
  shared-state assertions demonstrate the admitted interleaving
  (`poke_saw == 1`, `pump_observed == 2`).

## The fix experiment (cm4-reference-fix.patch) and what it revealed

Three hunks transplanting the wasmtime/deltic rule (entry gating ends at
resolution): `Thread.block_internal` releases the slot when a RESOLVED
`needs_exclusive` task's holder-thread parks; `exit_implicit_thread`
releases only-if-holder; the callback loop's release/retake becomes
held-guarded.

Full-suite result: **everything passes except `test_callback_interleaving`**
(5/5 runs), which fails in its second progress-free poll window
(`assert(ret == EventCode.NONE)`, pristine :989–995 region).

## Mechanism, fully traced (both windows, both semantics)

Cast: producer1 and producer2, callback-lifted (`needs_exclusive`) in one
instance; a consumer feeding them futures and polling its waitable set.

1. producer1 is lowered and parks **pre-resolution** in its initial
   frame's sync `future_read(fut11)` (the consumer writes `wfut11` only
   later, :957) — slot held. The `STARTING` assertions for `todie`/
   producer2 (:934–:951) therefore hold under **both** semantics:
   pre-resolution gating is uncontested.
2. `wfut11` written → producer1's initial frame continues → async
   `fut12` read → BLOCKED → returns `CallbackCode.WAIT` — the callback
   loop releases the slot (:2187–2188). producer2 is admitted, runs its
   initial frame, parks pre-resolution in its sync `future_read(fut21)`
   — now producer2 holds the slot. Its STARTING→STARTED event is
   consumed at :959–963.
3. First poll window (:966–973): no pending events; producer2 parked
   pre-resolution (slot correctly held under both semantics). `NONE` ×10
   passes under both. ✔
4. `wfut21` written (:975) → producer2 continues → async `fut22` read →
   BLOCKED → WAIT → slot released. `wfut12` written earlier delivered
   producer1's FUTURE_READ; its callback runs: `canon_task_return(42)`
   (**RESOLVED**), then a **post-resolution sync `future_read(fut13)`**
   (:888–896 region) — parked mid-frame. The consumer consumes
   producer1's RETURNED subtask event (:977–985).
5. `wfut22` written (:987) → producer2's FUTURE_READ event is pending;
   producer2 sits in callback-WAIT needing the slot to retake.
   - **Pristine**: the slot is held by producer1's post-resolution sync
     read → producer2 cannot wake → second poll window (:989–995) sees
     `NONE` ×10. ✔ (hold-semantics encoded here)
   - **Fix**: `block_internal` released producer1's slot → producer2
     retakes, its callback runs `task.return` → RETURNED → a SUBTASK
     event (`state = RETURNED`) lands in the consumer's set → the poll
     observes it → `assert(ret == EventCode.NONE)` fails. ✘
     (diagnostic observed: `event=SUBTASK p2=RETURNED` inside the window)

So: exactly one assertion window in the reference's unit tests depends on
the hold-semantics — and it is load-bearing there, while
`test/async/sync-streams.wast:208` (run by wasmtime CI, deterministically
green) demands the opposite. **The spec repo's two test corpora pin
contradictory semantics**, and since no upstream CI runs the wast corpus
against `definitions.py`, neither side can notice.

## Verdict for the fix patch

Honest verdict: irreconcilable without changing existing expectations —
by design, not by defect. A resolution-scoped `definitions.py` must also
rewrite `test_callback_interleaving`'s second poll window (consume the
producer2 RETURNED event there instead of asserting quiescence, and
re-sequence its tail). The patch is shipped as the demonstration of what
the wasmtime-aligned semantics look like in the reference's own model,
not as a ready-to-merge change.

## Harness note (for the filing's presentation)

Any failing assertion in a threaded run_tests.py test prints its
traceback and then hangs the interpreter on non-daemon reference threads
— verified by injecting `assert(False)` into stock
`test_async_backpressure` (traceback, then timeout). Run the suite under
`timeout`; judge by the traceback, not the exit.
