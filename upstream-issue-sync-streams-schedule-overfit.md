# Upstream issue draft: sync-streams.wast:145 asserts scheduler policy, not semantics

Target repo: WebAssembly/component-model
Status: not yet filed (filing tracked by deltic#15; adjudication record in
deltic#43)
Companion artifact: `upstream-sync-streams-schedule-agnostic.patch` (applies
at the spec repo root, verified against 73b7ad5)

---

Title: **test/async/sync-streams.wast:145 pins one scheduler policy: STARTED vs STARTING for entry into a gated instance is not normative**

`test/async/sync-streams.wast:145` (at 73b7ad5) hard-asserts that an
async-lowered call to `$C.set` reports STARTED in its packed result:

```wat
(local.set $ret (call $set (local.get $rx)))
(if (i32.ne (i32.const 1 (; STARTED ;)) (i32.and (local.get $ret) (i32.const 0xf)))
  (then unreachable))
```

At that instant `$C`'s exclusivity gate is held by the previous task:
`$C.get` has resolved (its `task.return` was delivered at line 32) but is
parked mid-frame in a synchronous `stream.write` (line 38) — and is ready to
resume, since `$D.run` already completed the first rendezvous. Whether the
new call reports STARTING or STARTED is then decided by *when* the host
evaluates the callee's admission, and the spec's two reference points
disagree:

- **canonical-abi/definitions.py decides eagerly, at the call instant**:
  `canon_lower` invokes the callee synchronously (definitions.py:2281),
  `canon_lift` creates and resumes the callee thread on the spot
  (:2211–2212), the thread parks at the still-held gate (:484–486), and the
  caller packs whatever state the subtask reached (:2306). Answer:
  **STARTING** — deterministically, under every schedule the deterministic
  profile can produce. The reference fails its own test suite's assertion.

- **wasmtime defers the decision**: `start_call` queues the callee and
  suspends the caller until the first status event; ready work queued ahead
  (the parked-but-ready `$C.get`) runs to invocation exit and releases the
  gate before the new call's readiness is evaluated, so the callee is
  admitted and the caller learns **STARTED** (deterministic under wasmtime's
  FIFO; line refs and an execution trace against wasmtime main and v47.0.3
  are available on request).

The gate *semantics* are not in question — definitions.py's
`exclusive_thread` (released only at the event-loop wait :2187–2188 and task
exit :506–508), wasmtime's `do_not_enter` bracketing, and the
CanonicalABI.md:3740–3746 prose all agree the gate spans the whole core
invocation, mid-frame parks included. What differs is scheduler policy on
top of agreed semantics, and both policies are conforming: the spec
deliberately leaves task scheduling nondeterministic. A hard STARTED
assertion therefore pins the co-developed runner's policy (the wast corpus
documents wasmtime as its runner), while the reference interpreter itself
answers STARTING — and the contradiction has no detector today because CI
runs `run_tests.py` but never executes the wast corpus against
definitions.py.

## Proposed fix

Make the region schedule-agnostic; the test's real content — the sibling
call is eventually admitted once the gate-holder exits, and the stream
rendezvous completes correctly — is preserved under both policies:

1. accept STARTING **or** STARTED from the lower;
2. on STARTING, `waitable-set.wait` for the subtask's admission (STARTED)
   before touching the new stream — RETURNED cannot arrive first, because
   `$C.set` reads from a stream nothing has written to yet;
3. leave every other assertion in the file unchanged.

Patch attached (also happy to open it as a PR). Under a deferred-entry host
the test takes the STARTED arm, whose assertions are byte-identical to
today's — no coverage is lost on the current runner. Under an eager-entry
host (the reference's policy) the STARTING arm finally gives this scenario a
green path. We verified both arms on a Component Model runtime that
implements hold-lifetime gates with a drain-to-quiescence entry decision:
the patched test passes as written (STARTED arm), and a reordered variant
that makes the gate-holder unready at the call site — forcing the STARTING
answer — passes the STARTING arm's waits and asserts, including under
seeded-shuffle scheduling.

## Secondary, structural

Reference↔corpus contradictions of this class stay invisible until an
independent implementation trips over them. Running the wast corpus against
definitions.py in CI (or, short of that, flagging assertions known to encode
runner policy) would give them a detector.

---

Filing notes (not part of the issue body):

- Adjudication record: deltic#43 (final operator comment, 2026-08-10);
  tracker entry CM-4 in `upstream-component-model-repo-findings.md`. Same
  class as NOTE-1 (tests assuming the deterministic profile), sharper
  instance.
- Archived evidence tree (mechanism analysis with wasmtime line refs for
  both vintages, `trace-sync-streams-wasmtime-dev.log`, `verify-cm4.sh`
  whose legs 0–1 reproduce the reference-side STARTING answer against
  pristine definitions.py): `4f3351f:exams/wasmtime-exclusivity/`.
- Patch verification (2026-08-11, this repo at the 73b7ad5 submodule pin):
  pristine/patched/STARTING-variant legs all 2/2 through testgen +
  RuntimeExecutor, FIFO and DELTIC_SCHED_SEED=1/4242; the variant
  hard-asserts STARTING so its pass proves the new arm executed. Recipe: see
  the PR that added this file.
- wasmtime-side check of the patched test needs a **dev** CLI (`wasmtime
  wast -W component-model-async=y -W component-model-more-async-builtins=y
  test/async/sync-streams.wast`); 47-era release CLIs cannot parse the
  post-#655 suite syntax. By construction the patch only adds an arm
  wasmtime never takes, but running it pre-filing is a reasonable courtesy.
- Keep the deltic-specific framing out of the filed text: the issue body
  above names no deltic internals beyond "a Component Model runtime".
