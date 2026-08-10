# wasmtime's actual entry semantics: hold rule + deferred start (CM-4 correction)

**2026-08-10, operator-prompted source/trace verification. This document
supersedes the wasmtime characterization in `RESULTS.md`, `root-cause.md`,
the pre-correction `spec-amendment.md`, and CM-4's original evidence
section.** The earlier claim — "wasmtime's gate (`do_not_enter`) is scoped
to the sync-call span, ending at resolution" — is **false**. wasmtime holds
its entry gate for the whole core invocation, exactly like the reference's
`exclusive_thread`; its `sync-streams.wast` pass comes from *when the entry
decision is made*, not from gate lifetime.

Sources: `crates/wasmtime/src/runtime/component/concurrent.rs` at main
(fetched 2026-08-10; last commit touching it b6cb7446f, 2026-07-24; 6002
lines) and `v47.0.3` (5949 lines) — the bracket structure is identical in
both; 47.0.3 line numbers in [brackets].

## The gate, from source

- `ConcurrentInstanceState.do_not_enter: bool` — :5227 [:5192]. Exactly
  **two** assignment sites in the whole crate (submodules `abort.rs`,
  `func.rs`, `futures_and_streams.rs`, etc. grep-clean):
  `enter_instance` :2004–2010 [:1998] sets it, `exit_instance`
  :2014–2021 [:2008] clears it and re-evaluates `pending`
  (`partition_pending`).
- Every caller is a **core-invocation bracket**:
  - callback-lift initial invocation :2652/:2662 [:2647/:2657] — enter
    before `call(store)`, exit after the invocation returns a callback
    code;
  - sync-lift invocation :2696–2698/:2714 [:2691/:2709], with the
    stackful exemption (`if !async_`);
  - each callback invocation (DeliverEvent) :942/:960 [:937/:955].
- `task_return` :3329–3378 → `task_complete` :3411+: **no gate
  interaction**. Resolution does not touch `do_not_enter`.
- The blocking path used by sync builtins (`wait_for_event` :2199–2213,
  reached from `futures_and_streams.rs` `wait_for_write`/`wait_for_read`
  :3978/:4069) suspends the guest thread's fiber **with the bracket
  open**. A resolved task parked mid-frame in a sync builtin therefore
  *still gates its instance*.
- Entry readiness (`GuestCall::is_ready` :756–772):
  `StartImplicit` requires `!(do_not_enter || backpressure > 0)`;
  `DeliverEvent` requires `!do_not_enter`. Both kinds of same-instance
  progress — new entries *and* event deliveries to parked-between-
  invocations callback tasks — are deferred while any invocation is
  mid-frame.

## The scheduling, from source

The reference's `canon_lower` runs the callee **eagerly, inline**: the
entry check happens at the call instant and the packed STARTING/STARTED
status reflects that instant. wasmtime instead **defers**:

- `start_call` :3040–3160: a guest→guest call queues the callee's
  `StartImplicit` as a high-priority work item and the **caller suspends
  until the first subtask status event** (async-lowered callers take
  whatever that first status is, :3138–3153; sync-lowered callers loop
  until `Returned`).
- Work-item handling :1497–1522: when a queued call is popped and
  `is_ready` is false, a `Status::Starting` event is delivered to the
  caller (`starting_sent`) and the call parks in `pending` until an
  `exit_instance` → `partition_pending` makes it ready.

So the status an async caller observes is decided **after the executor has
drained work queued ahead of the call** — in particular, after any
ready-to-resume gate holder has run.

## Trace proof (`trace-sync-streams-wasmtime-dev.log`)

`wasmtime 49.0.0 (a276ccbe1 2026-08-10)` dev release, aarch64, flags
`-W component-model-async=y -W component-model-more-async-builtins=y`,
`WASMTIME_LOG='wasmtime::runtime::component::concurrent=trace'`, on the
pristine `test/async/sync-streams.wast` (submodule 73b7ad5). Key lines
(thread `(3,5)` = `$C.get`, `(12,14)` = `$C.set`, `(0,2)` = `$D.run`;
instance index 1 = `$C`):

1. `enter RuntimeInstance{index:1}` — get's initial invocation; gate set.
2. `task.return for (3,5)` — get resolves.
3. `suspend fiber: Waiting{set:4, thread:(3,5)}` — get parks mid-frame in
   the sync `stream.write`. Gate **still set**.
4. D's `guest_read` rendezvouses the write → `push high priority:
   ResumeFiber` (get) — queued *before* the `set` call exists.
5. D lowers `set` → `push high priority: GuestCall((12,14),
   StartImplicit)`; D suspends awaiting the first status.
6. FIFO: get's fiber resumes, its write returns `Dropped(4)`, the
   invocation returns EXIT → **`exit RuntimeInstance{index:1}`** →
   `delete guest task GuestTask(3)`.
7. Only now: `call GuestCall{(12,14), StartImplicit} ready? true
   (do_not_enter: false)` → `enter` → `Subtask{status: Started}` → D
   resumes and sees STARTED.

At the moment `set` was admitted, `get` was not parked mid-frame — it was
already exited and deleted. No same-instance execution ever overlapped
get's parked span.

## The corrected semantic model

wasmtime = **hold rule** (gate lifetime = the core invocation, identical
to `definitions.py`'s `exclusive_thread`) **+ deferred entry decision**
(caller learns STARTING only after runnable work queued ahead of the call
— including ready gate holders — has been exhausted) **+ FIFO work
queue**.

Consequences:

- `test/async/sync-streams.wast:145` does **not** pin release-at-
  resolution. It is satisfied by (a) wasmtime's hold + deferred start, and
  (b) release-at-resolution + eager start (deltic today; the
  `cm4-reference-fix.patch` experiment). It rules out only the
  reference's exact combination: hold + **eager** start.
- The reference's own `test_callback_interleaving` (both hold-encoding
  sites: the :990–995 NONE window and the :1009–1011 STARTING tail) is
  **consistent with wasmtime** — under hold + deferred start it passes
  unchanged. The "second contradiction" reported in `root-cause.md` is a
  property of the release-rule fix, not of wasmtime alignment.
- The exam's `test_resolved_task_gates_entry` (cm4-run-tests.patch)
  encodes the **release rule**, not wasmtime: its shared-state assertions
  (`poke_saw == 1`, `pump_observed == 2`) require admission *during* the
  resolved task's park. Under wasmtime's model poke is deferred until
  pump's invocation exits (STARTING at the lower; different interleaving
  values).
- The IROH-1 collision window (same-instance execution during a resolved
  task's mid-frame block) is **unreachable under wasmtime** for
  needs-exclusive shapes — `DeliverEvent` is `do_not_enter`-gated too —
  and reachable under deltic's release rule. wasmtime-green vs deltic-trap
  is a semantics difference, not host timing.
- wasmtime's own pass is **FIFO-order-dependent**: had the executor popped
  `set`'s `StartImplicit` before get's queued `ResumeFiber`, the caller
  would have seen STARTING and the guest would trap. Any reformulation for
  the reference (or deltic, which must stay green under
  `DELTIC_SCHED_SEED` shuffles) should therefore prefer the order-robust
  statement: *an async-lowered call reports STARTING only if the callee
  is still unstarted after the instance's runnable work is exhausted*
  (drain-to-quiescence, not pop-one).

## What survives from the original exam

- The reference↔wast-suite contradiction (CM-4 proper): pristine
  `definitions.py` deterministically traps on sync-streams.wast:146
  (STARTING where the suite demands STARTED). Still true; `verify-cm4.sh`
  legs 0–1 stand.
- The determinism measurement (50/50) and its conclusion — the wasmtime
  pass is deterministic. Only the *mechanism attribution* ("the gating
  rule alone decides") was wrong: determinism additionally rests on FIFO
  order and on get's readiness preceding the `set` lower.
- The CI-provenance analysis (spec repo CI runs only `run_tests.py`; the
  wast corpus's runner is wasmtime; no cross-check) — unchanged.
