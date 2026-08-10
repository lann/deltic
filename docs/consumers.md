# deltic — consumer adoption: the polymorph track

The first production consumers are the [polymorph-components] family —
`polymorph-{webcrypto,websocket,webrtc-datachannels,tls,test,iroh}` — and
experiment-mosh (a mosh client/proxy tunneled over the iroh endpoint
component). All run the same triangle {wasmtime host, JS host, in-guest
provider}; the JS host was jco (a pinned fork), and the jco legs are where
their plans were blocked. Replacing jco there is this project's adoption
target ([architecture.md §1](architecture.md)); jco-convention compatibility
is explicitly not part of it ([§2](architecture.md)) — the consumers have no
external dependents and port to conventions designed fresh
([contracts/embedder-api.md](../contracts/embedder-api.md)).

Their jco blockers map one-for-one onto this project's proven strengths
(every "our status" cell below is an executable gate — see
[milestones.md](milestones.md) rows C0–C3):

| Their blocker | Class | Our status |
|---|---|---|
| lann/jco#11 (= polymorph-iroh#10): execution-slot queue serializes task lifetimes — a detached pump task deadlocks every later export call; fix blocked behind further scheduler rearchitecting (jco #30, #31); costs iroh a ~5× handshake-latency polling workaround meanwhile | scheduler | task admission is the reference's `enter_implicit_thread` gate; parked callback-ABI tasks release exclusivity. Executable: smoke-c0 leg 2 and the iroh endpoint exam (40 export calls against live detached pumps) |
| lann/jco#13: guest-internal stream wakeups never delivered | scheduler | same-component streams/futures fully green; the exam's `accept` parks before a dial and is woken by the pump |
| lann/jco#14: composed async cross-component calls fail (`_asyncStartCall` param count) | fused adapters | FACT start-calls green across all four ABI pairings incl. spilled params; full composed-client E2E is [#2](https://github.com/lann/deltic/issues/2) |
| lann/jco#6/#7: subtask/future cancellation traps | cancellation | cross-component cancellation per reference (and upstream finding CM-3) |
| lann/jco#51: TDZ at import time — emitted trampoline references a resource class above its declaration (trigger: async cross-component call returning `own<resource>` + that resource re-exported in an exported interface) | codegen emission | the defect *class* cannot exist in a runtime linker — nothing is emitted; the minimized `compose-async-tdz` shape is a corpus fixture (smoke-c0 leg 1, green) |
| componentize-go `[async-lower]` imports: "Missing subtask" / hangs (wasmtime runs the same guests correctly — spec-valid guest, host at fault) | subtask bookkeeping | async-lower per the reference; the 8 MB componentize-go mosh engine instantiates and runs |

## Standing consequences

- **Co-evolution, not compatibility.** Conventions are designed against
  the consumers' host modules as reference implementations; they port; both
  sides pin exactly and upgrade deliberately — via git references and/or
  `pre-<shorthash>` prerelease artifacts; registry publishing is deferred
  ([#16](https://github.com/lann/deltic/issues/16), decision 2026-08-09).
- **WASI interfaces are design inputs even though implementations stay
  out of core.** The conventions must make wasi p2 idioms (pollables, io
  streams, error-code enums, resource-heavy surfaces) and p3 idioms
  (stream/future-bearing signatures, async resource methods,
  error-context) natural to implement in JS — whoever adopts this host
  writes shims against these conventions, and the broader ecosystem's
  most important interfaces are exactly these. The embedder-api contract
  carries paper signatures for a representative WASI slice; the
  `wasi-shims/` package is the executable check.
- **Their suites are engine sanity checks, not gates** (operator ruling,
  2026-08-10; supersedes the earlier "their suites become our gates"
  posture and the release-gate framing of the now-closed
  [#6](https://github.com/lann/deltic/issues/6)). This family surfaced at
  least five distinct jco defect classes that no WAST corpus expresses
  (long-lived composed workloads, background pumps, cross-task wakeups,
  codegen-shape triggers) — and five deltic runtime defects the same way
  (smoke-c0's R-1/R-2; the tls smoke's three,
  [#18](https://github.com/lann/deltic/issues/18)) — so running them is
  high-yield. But everything on both sides is unstable and co-evolves in
  tandem: a consumer-suite delta is a finding to triage, never a blocker
  for upstreaming or release.
- **What replacing jco does not replace**: componentize-js/-go (guest
  production — out of scope per [architecture.md §2](architecture.md); their
  output components are ordinary inputs to us) and the wasmtime host legs
  (the native story).
- **Unlocks on their side, recorded for the cutover argument**: no
  transpile step, generated trees, flag-verification scripts, or fork
  pins; the Node 24 + JSPI-flag lane replaced by a flagless Deno lane
  (WebRTC included — verified below) and browser legs beyond Chromium;
  fresh-instance-per-case without re-transpile (their runners
  re-instantiate after poisoning); waker-based cross-task wakeups
  restoring the polling-workaround latency.

## Cutover state — the jco disposition

Operator ruling (2026-08-10, recorded on
[#14](https://github.com/lann/deltic/issues/14)): **jco support/coverage is
retained in polymorph-webcrypto only.** Every other repo's jco legs come out
once its deltic coverage twin exists — on operator signal, not autonomously.

| Repo | deltic twin | jco legs |
|---|---|---|
| webcrypto | deno legs merged ([#352](https://github.com/polymorph-components/polymorph-webcrypto/pull/352)); no browser twin needed | **retained indefinitely** — the Chromium side of the Deno platform-gap ledger, and the standing venue for [#17](https://github.com/lann/deltic/issues/17) |
| tls | deno + browser merged (their [#36](https://github.com/polymorph-components/polymorph-tls/pull/36), [#39](https://github.com/polymorph-components/polymorph-tls/pull/39)) | removed (their [#40](https://github.com/polymorph-components/polymorph-tls/pull/40)), then **reverted for the [#17](https://github.com/lann/deltic/issues/17) measurements** (their [#41](https://github.com/polymorph-components/polymorph-tls/pull/41)); re-lands on operator signal |
| iroh | `host-deltic` merged (their [#36](https://github.com/polymorph-components/polymorph-iroh/pull/36)) | removal prepared, parked as **draft** (their [#39](https://github.com/polymorph-components/polymorph-iroh/pull/39); closes their #10 on landing; follow-ups: their #37 polling retirement, #38 bench call counts) |
| websocket | deno merged (their [#40](https://github.com/polymorph-components/polymorph-websocket/pull/40)); browser in review (their [#41](https://github.com/polymorph-components/polymorph-websocket/pull/41)) | queued behind their #41 |
| webrtc-datachannels | deno merged (their [#149](https://github.com/polymorph-components/polymorph-webrtc-datachannels/pull/149)); browser twin needs a page-context runner (no `RTCPeerConnection` in workers) | blocked on the page runner |
| test | n/a — already jco-free as a gate | keeps publishing the jco-era compat surface webcrypto's retained lanes pin |

Ordering rule (operator, 2026-08-10): the
[#17](https://github.com/lann/deltic/issues/17) perf comparison runs
**before** a repo's jco legs are deleted — tls's removal was reverted to
honor it. webcrypto stays measurable indefinitely either way.

## Deno substitutes for Node (C0 evidence)

Node is **not a consumer requirement.** Deno functionally substitutes across
the whole consumer capability surface — verified empirically (2026-08-08,
Deno 2.9.5/linux-arm64, `tools/probes/webrtc-deno/`):

| Capability | Deno path | Status |
|---|---|---|
| WebRTC | `node-datachannel/polyfill` (the polymorph Node legs' exact dependency) as a Node-API addon | verified: full data-channel loopback green |
| WebRTC fallback | `werift` (pure TS, no native code) | verified: same loopback green |
| WebSocket | built-in `WebSocket` | native |
| WebCrypto | `globalThis.crypto.subtle` | native |
| UDP/TCP | `Deno.listenDatagram` / node-compat `dgram`, `net` | native/compat |
| fs/process/spawn | node compat + native APIs | native/compat |

Node stays a nearly-free *distribution* target via npm (the callback-ABI path
needs no JSPI flag), not a test lane, until someone needs it.

## In-repo consumer artifacts

Reference implementations developed here; the host modules and the iroh exam
now have consumer-owned upstreamed copies, and the long-term disposition of
the in-repo references is
[#14](https://github.com/lann/deltic/issues/14)'s remaining open item:

| Path | What | Gate |
|---|---|---|
| `ports/websocket` | `polymorph:websocket/connections` host module | their conformance suite 55/55 incl. TLS (`conformance/run.ts`); their deltic-deno + deltic-browser rows run the upstreamed copy |
| `ports/webcrypto` | `polymorph:webcrypto` host module (full surface — [#3](https://github.com/lann/deltic/issues/3) closed) | KATs vs their vectors + iroh exec-model integration |
| `ports/webrtc` | `polymorph:webrtc-datachannels/connections` host module | their echo-demo component over real data channels; their full driver-ct loopback matrix (solo+pair, 37/37) runs under the upstreamed copy ([polymorph-webrtc-datachannels#149](https://github.com/polymorph-components/polymorph-webrtc-datachannels/pull/149)) |
| `exams/iroh-endpoint` | the endpoint exit exam | 5/5: bind+identity, relay echo, WebRTC upgrade, jco#11/#13 assertions, teardown; upstreamed as their `host-deltic/` + `just exam-deltic` ([polymorph-iroh#36](https://github.com/polymorph-components/polymorph-iroh/pull/36), merged — all host modules from the sibling checkouts, incl. polymorph-webcrypto's own deltic module) |
| `ct-runner` | L3 runner for the polymorph-test L1 contract | golden-tested L4 JSONL; drives the websocket suite |
| `tools/smoke-c0` | C0 smoke legs + report | legs 1–4 (`REPORT.md`) |
| `tools/smoke-tls` | polymorph-tls conformance under deltic ([#18](https://github.com/lann/deltic/issues/18)) | translate 8/8; suites: zero failures, zero xfails on every composition — tag gating ([#25](https://github.com/lann/deltic/issues/25), `ct-runner/src/tags.ts`) schedules the per-target inapplicable cases to `not-applicable` exactly like their harness legs; the callback-null-context defect it found ([#24](https://github.com/lann/deltic/issues/24)) is fixed — attribution sentinels, `runtime/src/jspi/bridge.ts` |

Deferred consumer surfaces: iroh UDP direct path
([#4](https://github.com/lann/deltic/issues/4)). Closed since this list was
first drawn: webcrypto family completion
([#3](https://github.com/lann/deltic/issues/3), done), experiment-mosh deep
E2E ([#2](https://github.com/lann/deltic/issues/2), operator-managed
separately).

Defects found in consumer code while running their artifacts are tracked in
[`../upstream-consumer-findings.md`](../upstream-consumer-findings.md)
(filing: [#15](https://github.com/lann/deltic/issues/15)).

[polymorph-components]: https://github.com/polymorph-components
