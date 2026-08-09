# deltic — development protocol

Instructions for agents (and context for humans) working in this repo. The
repo was built by a multi-agent workflow and its discipline is part of the
project: unusually dense objective gates are what make delegated
implementation safe.

## Authorities

- Semantic tie-breaker for runtime behavior: the Component Model spec +
  `design/mvp/canonical-abi/definitions.py` (in the
  `third_party/component-model` submodule), with wasmtime as corroborating
  evidence — never the other way around. See
  [docs/architecture.md](docs/architecture.md) §1 for the parity policy.
- Interface contracts between workstreams live in `contracts/` (plan format,
  descriptor IR, intrinsics, digest, embedder API). **Contract changes are
  versioned events made only by the orchestrator**; implementation tracks
  report contract friction, they never edit around it.
- Design and decisions: [docs/architecture.md](docs/architecture.md).
  Milestone record: [docs/milestones.md](docs/milestones.md). Consumer
  track: [docs/consumers.md](docs/consumers.md). Upstream links:
  [docs/references.md](docs/references.md).

## Gates (exact commands)

Run the ones your change can affect; a full pass before commit looks like:

```sh
cargo build --workspace
cargo test -p translator-shim -p bindgen -p testgen
(cd runtime && deno task check && deno task test)
(cd harness && deno task conformance)        # official CM suite, Deno lane
(cd wasi-shims && deno task test)
(cd ct-runner && deno task test)
(cd ports/websocket && deno task test)       # + deno task conformance (spawns their echod)
deno run --allow-read tools/smoke-tls/run.ts --exec  # polymorph-tls suite (issue #18)
(cd ports/webcrypto && deno test --allow-read tests/)
(cd ports/webrtc && deno test -A webrtc.test.ts)
deno run -A tools/browser/run-lane.ts chromium   # firefox / webkit likewise
deno run -A tools/shell/run-lane.ts sm-pinned    # pinned engine shells (required
                                                 # gates; jsc-pinned is x64-only)
deno run -A --unstable-net exams/iroh-endpoint/run.ts   # needs iroh-relay on PATH
```

Scheduler-order sensitivity: rerun affected suites with `DELTIC_SCHED_SEED=1`
and `=4242` (seeded-shuffle mode; FIFO when unset).

Conformance discipline: the harness fails loudly on unexpected failures *and*
on stale xfails; per-browser deltas live in `harness/browser/expectations/`
with stale-delta detection. Never absorb a regression into an xfail/overlay
without a named class and a tracking issue.

## Multi-agent protocol

Work is parallelized across model-pinned subagents defined in the operator's
**global** opencode config — deliberately not vendored into this repo, so all
repo-specific context (contracts, spec authorities, gates) travels in each
dispatch prompt.

| Agent | Model | Role |
|---|---|---|
| orchestrator (primary session) | fable | planning, contracts, dispatch, integration, review, **all commits** |
| `coder` | sonnet | implementation tracks against pinned contracts |
| `coder-hard` | opus | subtle tracks: shim internals, CABI edge cases, scheduler periphery |
| `reviewer` | fable | parallel code review when the orchestrator is the bottleneck |
| `explore` | haiku | fast read-only codebase search |

Dispatch rules:

- Every track prompt names: **territory** (paths owned), **governing
  contracts** (`contracts/*.md` + design-doc sections), and **gates** (exact
  commands). Territories are disjoint across concurrent tracks.
- Subagents never commit (permission-enforced); the orchestrator commits
  after review.
- The task-scheduler **core** is single-owner (coherence risk):
  `coder-hard` at most, under close orchestrator review; parallelism stays at
  the periphery.

Review protocol: every track is reviewed against its contracts before commit
— by the orchestrator inline, or by `reviewer` subagents in parallel. A
review dispatch **must** name the diff scope, the governing `contracts/*.md`,
and — for anything touching CABI/async semantics —
[docs/architecture.md](docs/architecture.md) §5–§7 plus the spec sources
(`definitions.py` as tie-breaker): the reviewer judges only against named
authorities and flags unnamed ones rather than filling gaps from memory.
Revision rounds go back to the *same* coder session via `task_id` (context
intact), not a fresh agent.

Failure recovery (content-filter false positives, driver interrupts): an
aborted `task` call kills neither the child session (context persists in the
opencode db) nor its effects (files/commands persist on disk). Ladder:

1. Locate the orphan (`opencode-agent-sessions <parent-session-id>`, on
   PATH); resume via `task_id` — "summarize status, then continue".
2. Two failed resumes → assume poisoned context: fresh agent, handoff prompt
   = original track + "partial work exists, audit state first" + artifact
   pointers. Gates arbitrate what's already done.
3. Repeated failures across fresh contexts → escalate to the human; the
   trigger may live in the artifacts themselves.

Standing rules:

- After any fan-out, reconcile launched-vs-completed before proceeding — a
  missing result is not missing work.
- Never run one-off `npm:` specifiers (e.g. `deno run npm:yaml`) from the
  workspace root: Deno records them into the root `deno.lock`, silently
  dirtying the tree (bitten twice by YAML-parsing one-offs). Use python3 or
  run from `/tmp`; check `git diff deno.lock` before staging.
- `main` is branch-protected: required checks = the `core` CI matrix,
  force-pushes and deletions blocked, auto-merge enabled. Admin direct
  pushes still work (`enforce_admins: false`), but PR + auto-merge is the
  preferred delivery: it gets the required checks for free. The `browser`
  job is deliberately NOT a required PR check (it runs post-merge only,
  gating the prerelease) — do not add it to the protection contexts or
  PRs will never merge.
- Consumer checkouts (the polymorph family, under `~/p/polymorph/`) are
  **strictly read-only**: verify `git status` in any consumer tree you ran
  commands near, before and after. Build artifacts go to `/tmp` or a
  redirected `CARGO_TARGET_DIR`, never into consumer trees.
- Findings against foreign repos go in the tracker files
  (`upstream-component-model-repo-findings.md`,
  `upstream-consumer-findings.md`), not inline notes; filing them is the
  operator's call.
