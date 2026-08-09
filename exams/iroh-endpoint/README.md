# C3-IROH — the iroh endpoint exit exam

Runs the **real polymorph-iroh endpoint component** under component-engine on
Deno: the workload that is structurally dead under jco
([lann/jco#11](https://github.com/lann/jco/issues/11) — a detached pump task
holding in-flight imports deadlocks every later export call; #13 cross-task
wakeups). Their JS consumer driver
(`polymorph-iroh/host-jco/src/run-endpoint.mjs`) is, in their README's words,
"ready for when it lands". This exam ports that driving logic — not the jco
wiring — onto `@component-engine/runtime/embedder` plus the committed
`ports/{websocket,webcrypto,webrtc}` and `wasi-shims`.

```sh
# once: the stock upstream relay, built inside the consumer tree
(cd /home/lmartin/p/polymorph/polymorph-iroh/.deps/iroh && \
   cargo build --release -p iroh-relay --features server --bin iroh-relay)

deno run -A --unstable-net exams/iroh-endpoint/run.ts   # spawns/reaps the relay itself
deno check run.ts src                                   # from this directory
```

Nothing here writes into a consumer tree. The endpoint component is read from
`polymorph-iroh/target/wasm32-wasip2/release/iroh_endpoint.wasm`; if that
artifact is missing or stale (checked by its import set, not its mtime) it is
rebuilt with `CARGO_TARGET_DIR=/tmp/opencode/c3-iroh-target`.

## Scenarios

| # | Scenario | What it proves |
|---|---|---|
| 1 | bind + identity | `Endpoint.bind` mints an Ed25519 identity through `ports/webcrypto` and stands up the relay connection; the detached pump is then alive and **later export calls still complete** (lann/jco#11). Also asserts **zero `wasi:sockets` calls** — the browser profile. |
| 2 | relay echo | Two endpoint instances in one process, dialled by endpoint id through a stock `iroh-relay --dev`; one authenticated echo each way over QUIC streams. Their `endpoint-relay` matrix row. |
| 3 | WebRTC upgrade | The same connection, dialled on the relay with a `webrtc` upgrade hint, moves onto a data channel — `connection.path` reports `webrtc`. Browser reach beyond jco, made concrete. |
| 4 | concurrency proof points | 40 export calls against two live pump tasks (jco#11); `endpoint.accept` parked **before** the dial and woken by the pump, plus `accept-bi`/`wait-closed` woken by peer activity (jco#13). |
| 5 | teardown | `close` + awaited `wait-closed`, idempotent `close`, handle drop, and the relay process reaped. |

**Not claimed here:** lann/jco#14 (composed async calls). The endpoint is a
single component in this exam — no `wac plug` — so that row belongs to the
experiment-mosh composed client, not to this file.

## FINDING C3-IROH-1 — the consumer defect the exam retries around

`polymorph-iroh/endpoint/src/endpoint_impl.rs:13` states an invariant: "the
`RefCell` borrows never cross an await". They do:

```
State::drain()                          # runs under shared.borrow_mut()
  -> noq / rustls handshake work
    -> Signer::sign                     # core/src/crypto/sign.rs:104
      -> wit_bindgen::block_on(polymorph:webcrypto/signature#signing-key.sign)
```

`block_on` on an **async import** is a yield point: the callback-ABI
activation returns to the host and is resumed later, so another task of the
same instance may run while `drain`'s borrow is live. Every other endpoint
task (`connect`, `accept`, `open-bi`, …) parks in `wait_until`
(`endpoint_impl.rs:939`), whose first act is `shared.borrow_mut()` — panicking
`RefCell already borrowed` and aborting the guest with an `unreachable` trap.
The panic site is the victim; the borrow-holder is the culprit.

Confirmed directly by instrumenting `ports/webcrypto`'s `SigningKey.sign`: the
trap always lands **between the enter and exit of the TLS CertificateVerify
signature**, never elsewhere.

This is latent on every host. component-engine reaches it more often because
a RESOLVED task that blocks mid-frame releases `inst.exclusiveThread`
(`runtime/src/jspi/bridge.ts:349-394` — a documented wasmtime-tracking
divergence from `definitions.py`'s `canon_lift`, which holds the slot across
such a block). The pump rides `bind`'s *resolved* task, so its `block_on`
opens the instance to the parked poller.

The exam therefore retries scenarios 2–4 a bounded number of times and prints
every observed panic. Scenarios 1 and 5 are deterministic.

## Port friction recorded (worked around, not patched)

1. **`ports/webcrypto`** publishes the `signing-key-options` resource class
   only under `polymorph:webcrypto/ed25519-sign@0.1.0`, but the WIT that
   *defines* it is `signature` (`polymorph-webcrypto/wit/webcrypto.wit:604`);
   `ed25519-sign` merely `use`s it. Instantiating this endpoint against the
   stock fragment fails with a `PlanError`. `src/harness.ts`'s
   `webcryptoFragment()` re-publishes the same class under the defining
   interface; the real fix belongs in `ports/webcrypto`.
2. **`ports/webrtc`** resolves `node-datachannel` with a bare specifier from
   its own source file, but Deno resolves that against the *entry project's*
   scope. A standalone consumer therefore silently loses the backend (the
   top-level `await …catch` swallows it) and `new PeerConnection` throws a
   trap. Fixed here by mapping the specifier explicitly in `deno.json`'s
   `imports`; a consumer that only copies `package.json` will hit this.
