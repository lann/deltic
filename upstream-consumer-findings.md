# Upstream consumer-repo findings

Single source for issues/PRs to file against the **polymorph consumer
repositories** (docs/consumers.md) discovered while running their artifacts under
deltic. Mirrors the conventions of
`upstream-component-model-repo-findings.md`: entries carry status
(`DRAFT` → `FILED #n` → `RESOLVED`), evidence, and proposed fixes. All
filing is the operator's (foreign repos).

---

## IROH-1 — endpoint holds a `RefCell` borrow across a post-resolution `block_on` (DRAFT)

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

**The precise semantics (sharpened 2026-08-09; see
`upstream-component-model-repo-findings.md` CM-4 and
`exams/wasmtime-exclusivity/RESULTS.md`):** the boundary is
**resolution**.

- *Before* `task.return`, a callback task's instance-entry gate holds
  across mid-frame blocks on every implementation surveyed (deltic,
  wasmtime, and `definitions.py` alike) — borrows held across a
  pre-resolution `block_on` are safe.
- *After* `task.return`, the semantics the official suite pins
  (`test/async/sync-streams.wast:208` — the interloper task is admitted,
  its body runs, and it touches shared instance memory while the resolved
  task sits parked mid-frame; wasmtime runs this suite in CI via its
  `tests/component-model` submodule and passes it **deterministically**,
  50/50 measured on wasmtime 49.0.0-dev) **admit other same-instance
  tasks running while the resolved task's thread is blocked mid-frame**.
  wasmtime's own gate (`ConcurrentInstanceState.do_not_enter`) ends at
  resolution. `definitions.py` as written disagrees (its
  `exclusive_thread` is held for the whole activation) — that
  contradiction is CM-4, a separate filing against the spec repo; the
  suite + wasmtime are the operative semantics today, and deltic
  implements them.

The endpoint's pump does its `block_on(sign)` **after** `bind` resolved,
inside that admitted window, with the `RefCell` borrow live.

**Why the wasmtime leg is green anyway — deterministic schedule, not a
guarantee:** wasmtime admits the same interleaving (its own suite asserts
it); its particular deterministic scheduler simply never chooses the
parked poller inside the signing window on this workload. deltic's
deterministic scheduler does, ~90% of the time. Same semantics, different
schedules — "works on wasmtime" is survivorship, and any scheduler change
(wasmtime's included) can flip it.

**Proposed fix (guest-side):** scope the borrow inside `drain`'s inner
steps, or move signing out of the borrowed region (take what `sign`
needs, release, sign, re-borrow). General rule: treat every
**post-resolution** mid-frame block as a potential same-instance
interleaving point.

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

## Out of scope here, tracked where they belong

- Spec/reference findings: `upstream-component-model-repo-findings.md`.
- `ports/webrtc` foreign-entry npm resolution (import-map requirement):
  documented in `ports/webrtc/README-import-map note` and the exam's
  deno.json; a Deno resolution mechanic, not a consumer defect.
