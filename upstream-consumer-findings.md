# Upstream consumer-repo findings

Single source for issues/PRs to file against the **polymorph consumer
repositories** (docs/consumers.md) discovered while running their artifacts under
deltic. Mirrors the conventions of
`upstream-component-model-repo-findings.md`: entries carry status
(`DRAFT` → `FILED #n` → `RESOLVED`), evidence, and proposed fixes. All
filing is the operator's (foreign repos).

---

## IROH-1 — endpoint holds a `RefCell` borrow across a post-resolution `block_on` (RESOLVED-BY-HOST via deltic#43; see Disposition)

**Repo:** polymorph-iroh. **Where:** `endpoint/src/endpoint_impl.rs:13`
(claim: "the `RefCell` borrows never cross an await") vs the actual path:

```
State::drain()                      # under shared.borrow_mut()
  -> noq/rustls handshake
    -> Signer::sign                 # core/src/crypto/sign.rs:104
      -> wit_bindgen::block_on(polymorph:webcrypto/signature#signing-key.sign)
```

`block_on` on an async import blocks the thread mid-frame (sync
`waitable-set.wait` under the callback ABI); whether other same-instance
tasks may run during that window is the load-bearing question — see the
sharpened semantics below. Every other endpoint task parks in `wait_until`
(`endpoint_impl.rs:939`) whose first act is `shared.borrow_mut()` →
`RefCell already borrowed` → `unreachable` trap.

**Evidence:** found by `exams/iroh-endpoint/` (deltic C3 exam).
Instrumenting the host's `SigningKey.sign` shows the trap always lands
inside the TLS CertificateVerify signature window; relay-auth signs
(at bind, no poller parked yet) never trip it. Measured under
deltic: ~90% of runs with `accept` parked across the
handshake. The 5 ms bounded-polling cadence (their jco workaround)
re-arms `wait_until` on the same timescale as the signing window, making
the collision near-certain on any host that interleaves there.

**The precise semantics (corrected 2026-08-10; see
`upstream-component-model-repo-findings.md` CM-4 and
`exams/wasmtime-exclusivity/wasmtime-actual-semantics.md`):** the
collision window is **deltic-specific**, not spec-pinned.

- *Before* `task.return`, a callback task's instance-entry gate holds
  across mid-frame blocks on every implementation surveyed (deltic,
  wasmtime, and `definitions.py` alike) — borrows held across a
  pre-resolution `block_on` are safe.
- *After* `task.return`: **wasmtime keeps holding the gate** for the rest
  of the invocation (`do_not_enter` spans each core invocation; source +
  trace verified), and gates event delivery to other same-instance tasks
  the same way (`GuestCall::is_ready`, concurrent.rs:765). Under wasmtime
  the poller *cannot* be resumed inside the pump's parked signing window
  — the collision is **unreachable by semantics**, not by timing.
  `definitions.py` agrees on the gate lifetime. **deltic today is the
  outlier**: its release-at-resolution rule (2026-08-09 CM-4 working
  assumption, since corrected) admits same-instance tasks during the
  post-resolution parked span — that admitted window is where this trap
  lives. The official suite (`sync-streams.wast`) pins neither rule; it
  pins deferred entry *timing* (CM-4, corrected).

The endpoint's pump does its `block_on(sign)` **after** `bind` resolved,
inside the window deltic's current rule admits, with the `RefCell` borrow
live.

**Why the wasmtime leg is green — a semantics guarantee, not timing
luck (corrected 2026-08-10):** the previous revision of this entry
predicted latency injection would reproduce the trap on wasmtime; the
corrected model predicts the opposite — under wasmtime the poller's
timer event sits gated in `pending` until the pump's invocation exits,
at any signing latency. (Falsifiable both ways: add ~1 ms to the
wasmtime host's `sign`; the corrected model says it stays green.) Under
deltic the same window is open by our own rule, and the 5 ms poll
cadence lands in it ~90% of the time with a `crypto.subtle` signer.

**Disposition (2026-08-10, updated after deltic#43 landed):** deltic now
implements wasmtime's hold + deferred-entry model
([deltic#43](https://github.com/lann/deltic/issues/43)) — the admitted
window this trap lived in **no longer exists on any surveyed host**, by
semantics (pinned by `runtime/tests/entry_deferral_test.ts`). Empirical:
`just iroh-exam` scenarios 1/2/4/5 pass post-#43, including the
IROH-1-shaped legs (accept parked across a handshake, scenarios 2 and 4);
the exam's retry workaround for scenarios 2–4 is expected redundant and
can be retired after a few more green runs. (Scenario 3 fails on this
machine with a WebRTC backend-resolution error — differentially confirmed
pre-existing on pristine main, unrelated to #43.) **This entry is
RESOLVED-BY-HOST; no consumer filing needed.** The guest-side hygiene
below remains advisable independent of host (borrows across any
`block_on` are fragile under future spec evolution and under hosts
exploring allowed nondeterminism).

**Proposed fix (guest-side, now optional hardening):** scope the borrow
inside `drain`'s inner steps, or move signing out of the borrowed region
(take what `sign` needs, release, sign, re-borrow).

**Workaround in-tree:** the exam retries scenarios 2–4 (observed 8/20
attempts trip it); residual all-attempts-fail probability < 1%.

---

## WEBCRYPTO-PORT-1 — resource classes must be published under the DEFINING interface (RESOLVED in-tree; upstream doc note optional)

Not a consumer bug — recorded for the eventual upstreaming of
`ports/webcrypto`: `signing-key-options` is defined by
`polymorph:webcrypto/signature` (webcrypto.wit:604,613) and only `use`d
by `ed25519-sign`; a component linking both resolves the resource type
against the definer. Fixed in `ports/webcrypto/src/signature.ts` (the
class is published under both). General rule for all ports: every
resource class goes under its defining interface; `use`rs may re-export.

---

## POLYMORPH-TEST-HARNESS-1 — freshCases re-pick is a linear name() scan (quadratic in suite size)

`runCases`' freshCases branch re-enumerates and scans front-to-back,
calling `name()` per entry until the match (js/viewer/harness.mjs:181-189).
For an n-case suite that is Σi ≈ n²/2 `name()` round-trips per run —
~182M for polymorph-webcrypto's 19k-case shared suite — and every
`name()` is a host-boundary crossing on any runner. deltic's ct-runner
mirrored the scan verbatim and now fronts it with a same-index-first
fast path (census index as a hint, full scan as the fallback, drift
semantics unchanged — `ct-runner/src/run-suite.ts` `findByName`); the
same fix transplants to harness.mjs directly. Filing upstream is the
operator's call.

---

## Out of scope here, tracked where they belong

- Spec/reference findings: `upstream-component-model-repo-findings.md`.
- `ports/webrtc` foreign-entry npm resolution (import-map requirement):
  documented in `ports/webrtc/README-import-map note` and the exam's
  deno.json; a Deno resolution mechanic, not a consumer defect.
