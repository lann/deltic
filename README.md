# deltic

A WebAssembly **Component Model host** for JavaScript engines — async-native
(Component Model 0.3 concurrency), built on wasmtime's translation frontend
compiled to wasm, running on Deno and in browsers.

Instead of ahead-of-time transpilation, deltic is a **runtime linker**: it
takes a `.wasm` component binary, translates it in-process (wasmtime-environ +
FACT fused adapters, running as a wasm32 module), and executes the
instantiation plan on the stock `WebAssembly` JS API. Cross-component calls
stay pure wasm; the 0.3 task model (tasks, streams, futures, backpressure,
cancellation) is the runtime's core structure, mapped onto the JS event loop —
the callback ABI needs no JSPI at all, and the stackful/blocking forms light
up via JSPI where the engine provides it.

## Status

Pre-1.0, but densely gated:

- **Official Component Model test suite**: 1250 passing / 0 failing commands
  across all directories (remaining: named xfail classes — wasmparser pin
  drift, 🧵-deferred, small gaps), identical on Deno and Chromium; Firefox
  green behind its JSPI pref (one trap-*wording* variance); WebKit capped
  only by JSC's missing multi-memory.
- **Real-workload proof points** (the [polymorph] component family):
  the iroh endpoint component — detached pump tasks, multi-export
  concurrency, cross-task wakeups; the workload that deadlocks jco's
  scheduler — runs its relay-echo and WebRTC-upgrade paths end-to-end;
  polymorph-websocket's conformance suite passes 55/55 under this host;
  an 8 MB componentize-go engine instantiates and runs.
- Guest toolchains exercised: wit-bindgen (Rust) and componentize-go,
  sync and async.

## Layout

| Path | What |
|---|---|
| `crates/translator-shim` | wasmtime-environ + FACT → versioned plan format (wasm32, runs everywhere) |
| `runtime/` | TS core: plan executor, canonical ABI, 0.3 task scheduler, JSPI bridge, embedder API (`runtime/src/embedder`) |
| `crates/bindgen` | WIT → TypeScript types for the embedder conventions |
| `wasi-shims/` | minimal WASI providers (p2 baseline + p3 clocks), one per semver track |
| `ct-runner/` | conformance-suite runner for the polymorph-test L1 contract |
| `harness/` + `tools/browser` | official-suite harness; Deno lane + Chromium/Firefox/WebKit lanes |
| `contracts/` | the versioned interface contracts (plan format, embedder API, intrinsics, digest) |
| `ports/`, `exams/` | polymorph host-module ports and consumer exams (reference implementations pending upstreaming) |

## Quick start

```sh
git clone --recursive https://github.com/lann/deltic
cd deltic
cargo build -p translator-shim --target wasm32-unknown-unknown --release
(cd runtime && deno task test)          # runtime suite
(cd harness && deno task conformance)   # official CM suite on Deno
deno run -A tools/browser/run-lane.ts chromium   # same corpus, real browser
```

Design, decisions, and milestone history: [`PLAN.md`](PLAN.md). The
embedder-facing conventions (value shapes, errors, resources, streams,
version canonicalization): [`contracts/embedder-api.md`](contracts/embedder-api.md).

[polymorph]: https://github.com/polymorph-components

---

<sub><i>125% more engine!</i></sub>
