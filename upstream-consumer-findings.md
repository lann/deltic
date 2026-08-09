# Upstream consumer-repo findings

Single source for issues/PRs to file against the **polymorph consumer
repositories** (docs/consumers.md) discovered while running their artifacts under
deltic. Mirrors the conventions of
`upstream-component-model-repo-findings.md`: entries carry status
(`DRAFT` → `FILED #n` → `RESOLVED`), evidence, and proposed fixes. All
filing is the operator's (foreign repos).

---

## IROH-1 — endpoint holds a `RefCell` borrow across a `block_on` yield (DRAFT)

**Repo:** polymorph-iroh. **Where:** `endpoint/src/endpoint_impl.rs:13`
(claim: "the `RefCell` borrows never cross an await") vs the actual path:

```
State::drain()                      # under shared.borrow_mut()
  -> noq/rustls handshake
    -> Signer::sign                 # core/src/crypto/sign.rs:104
      -> wit_bindgen::block_on(polymorph:webcrypto/signature#signing-key.sign)
```

`block_on` on an async import is a yield point (callback-ABI activation
returns to the host and resumes later), so other tasks run while the
borrow is live. Every other endpoint task parks in `wait_until`
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

**Why jco/wasmtime legs didn't surface it:** scheduling luck, not
absence — holding a `RefCell` borrow across a yield is illegal on any
conforming host. wasmtime's interleaving choices happen not to run the
poller inside that window (their matrix row is green); deltic's
do (see https://github.com/lann/deltic/issues/5 open question on the `bridge.ts` exclusivity
divergence, which widens — but does not create — the window).

**Proposed fix (guest-side):** scope the borrow inside `drain`'s inner
steps, or move signing out of the borrowed region (take what `sign`
needs, release, sign, re-borrow).

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
