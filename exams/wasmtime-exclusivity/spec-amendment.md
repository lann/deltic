# CM-4: how and why the spec would be amended (plain-language sketch)

Companion to `RESULTS.md` (evidence) and `root-cause.md` (mechanism). Those
prove the contradiction; this sketches the amendment that resolves it, for
the upstream filing. Line references: spec submodule `73b7ad5`.

## The rule in question

When an `async` export of a component instance is called, the Component
Model must decide when *other* async calls may enter the same instance.
For tasks that haven't opted into real concurrency (no stackful lift, no
threads), execution is serialized through a per-instance "exclusive" slot:
the task takes the slot when its core wasm starts and other entries wait.

Two moments could end that gating, and the spec repo currently pins one in
each corpus:

- **Hold rule** — the slot frees only when the task's core frames are done
  (task exit; released between callback invocations, but held across any
  mid-frame block). Pinned by `definitions.py` (`block_internal` never
  releases; exit at :506–508, callback loop at :2187–2203), stated in prose
  at CanonicalABI.md:3740–3748 ("held throughout each core wasm invocation
  from the event loop"), and load-bearing in
  `run_tests.py test_callback_interleaving` (the :990–995 quiescence window
  and the :1009–1011 STARTING assertion).
- **Release rule** — the gate ends at *resolution*: once the task delivers
  its result (`task.return`), its continued execution stops blocking entry
  (observable the next time it blocks, since execution is cooperative).
  Pinned by `test/async/sync-streams.wast:145` (STARTED asserted, trap
  otherwise), implemented by wasmtime (`ConcurrentInstanceState.
  do_not_enter`, a call-span bracket, not a task-lifetime lock) and by
  deltic.

Observable scope of the difference: only callback-lifted tasks between
`task.return` and EXIT. Sync-lifted tasks resolve exactly at frame return
(no post-resolution frame exists), and stackful tasks ignore the slot
entirely.

## Why the release rule should win

0.3 explicitly blesses the early-return producer pattern: resolve
immediately (say, with a stream handle), then keep executing in the
background to feed it — for an unbounded time. Under the hold rule that
pattern makes every producer an accidental instance-wide mutex: no other
async export can start for the producer's whole background lifetime, and if
the parked producer's progress ever depends on a gated entry (its stream's
consumer lives behind another export of the same instance), the instance
deadlocks.

The gate exists for two reasons, and neither needs the hold rule:

1. **Non-reentrance for the caller's synchronous span.** A sync caller must
   not see the instance reentered while its call is in flight. That need
   ends at resolution — resolution is precisely when the caller gets its
   result and moves on. (Concurrency.md:197–199 already reads this way:
   entry waits "for the previous call to **return** and release the lock" —
   in CM vocabulary a subtask "returns" at resolution.)
2. **Shadow-stack serialization** (Invariant #3). This is the one place the
   amendment has to spend something; next section.

Note Invariant #2 (reentrance only at explicit block points) is untouched:
under the release rule, entry still only happens when the resolved task
blocks or yields.

## What actually changes (all in the spec repo)

1. `definitions.py` — mechanical, ~3 hunks (prototyped in
   `cm4-reference-fix.patch`): when a resolved `needs_exclusive` task's
   thread blocks, release the slot and never retake it; make the two later
   releases (task exit, callback event loop) conditional on still holding.
2. `CanonicalABI.md:3740–3748` — restate the lock lifetime: a resolved
   task no longer gates entry. (The sync-lift clause "release after they've
   returned" survives as-is: for sync lifts, return *is* resolution.)
3. `Concurrency.md:197–199` — no semantic edit needed; optionally make
   "return = `task.return`" explicit, since that reading becomes normative.
4. `run_tests.py test_callback_interleaving` — the two hold-encoding
   sites: the second progress-free poll window (:990–995) must consume the
   admitted producer's RETURNED event instead of asserting `NONE`, and the
   tail (:1009–1011, subi3 STARTING) must be re-sequenced, since subi3 now
   enters immediately.
5. `Explainer.md` Invariant #3 (:3007–3011) — the real amendment; below.

## The one real cost: Invariant #3 gets a carve-out

Invariant #3 promises non-opted-in components that all their core wasm
execution is locally serialized "so that producer toolchains can continue
to use a single global linear memory shadow stack that is pushed and popped
in LIFO order." The shadow stack is the second stack toolchains like LLVM
keep in linear memory (address-taken locals etc.), with one global stack
pointer — sound only under LIFO push/pop.

The hold rule guarantees LIFO even when a task blocks mid-frame: nothing
else runs in the instance, so nothing pushes on top of the parked frames.
The release rule does not: a resolved task parked mid-frame keeps live
frames on the shadow stack while an admitted task pushes its own below;
depending on which side resumes first, pops go out of order and a later
push can land on still-live frames. Hand-written wat using only wasm locals
(sync-streams.wast itself) is immune; shadow-stack code is not. This is not
hypothetical at the semantic level: the same admitted-interleaving window
is IROH-1 (`upstream-consumer-findings.md`), where guest state assumed no
same-instance interleaving during a resolved task's block.

So the invariant's promise must be scoped to pre-resolution execution,
e.g.:

> …all core wasm execution *up to a task's resolution* is locally
> serialized… Code that continues executing after `task.return` must
> tolerate other tasks entering the instance whenever it blocks, and must
> not keep live shadow-stack frames across such blocking points.

That is a toolchain-visible contract change (bindings generators for
callback-lifted exports must keep post-resolution code either non-blocking
or frame-clean at blocks — in practice generated bindings already use the
callback/WAIT path, whose frame boundaries are clean, which is why the
release rule hasn't burned real toolchains yet). The alternatives that
avoid the carve-out both fail the existing corpus: keeping the hold rule
breaks `sync-streams.wast:145` and shipped wasmtime behavior; trapping
post-resolution blocking fails the same test. If the wast corpus stands,
the carve-out is forced.

## Why this likely lands (process)

- Both sides are the same author's work: Luke Wagner wrote the exclusivity
  model (#553, 2025-08-20) *and* `sync-streams.wast` with its STARTED
  assertion (9b5aa62, 2025-09-05, plus its later fixes). The filing is
  "your newer test contradicts your older reference", not "please bless an
  implementation deviation".
- wasmtime has shipped the release rule deterministically for ~a year, and
  the wast corpus's documented runner is wasmtime (test/README.md).
  Amending the reference changes nothing anyone runs in production;
  amending the test would change shipped behavior.
- Precedent: CM-3 (`upstream-component-model-repo-findings.md`) has the
  same triangle — suite + wasmtime vs. reference — resolved in the same
  direction (fix the reference).
- Structural follow-up for the same filing: the spec repo's CI runs only
  `run_tests.py` (main.yml:16); the contradiction stayed invisible for ~11
  months because no CI runs the wast corpus against the reference.
