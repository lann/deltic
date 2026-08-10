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
  drift, 🧵-deferred, small gaps), identical on Deno, Chromium, and Firefox
  (behind its JSPI pref); WebKit reaches the same totals on trunk builds
  (the pinned build lacks JSC multi-memory, since implemented upstream).
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
| `examples/` | **start here to embed**: hello-world + kitchen-sink (WIT + Rust guest + TS host, self-checking), plus the guest fixture corpus |
| `translator/` | `@deltic/translator`: the packaged translator asset + `defaultTranslator()` per-platform loader (build-time alternative: `tools/translate`) |
| `wasi-shims/` | minimal WASI providers (p2 baseline + p3 clocks), one per semver track |
| `ct-runner/` | conformance-suite runner for the polymorph-test L1 contract |
| `harness/` + `tools/browser` | official-suite harness; Deno lane + Chromium/Firefox/WebKit lanes |
| `contracts/` | the versioned interface contracts (plan format, embedder API, intrinsics, digest) |
| `ports/`, `exams/` | polymorph host-module ports and consumer exams (reference implementations pending upstreaming) |

## Quick start

```sh
git clone --recursive https://github.com/lann/deltic
cd deltic
just test-runtime    # runtime suite (builds the shim + fixtures + corpus first)
just conformance     # official CM suite on Deno
just browsers-install && just browser-lane chromium   # same corpus, real browser
```

Deno workspace (TS) + cargo workspace (Rust); [`just`](https://github.com/casey/just)
is the command surface (`just --list`; recipe bodies are the exact commands).

## Documentation

| Where | What |
|---|---|
| [`examples/`](examples/) | runnable embedder examples: [hello-world](examples/hello-world/) (smallest complete embedding) and [kitchen-sink](examples/kitchen-sink/) (imports incl. suspending, resources both directions, value-shape tour) |
| [`docs/architecture.md`](docs/architecture.md) | the system design and decisions, with rationale (§-numbered; cited from code comments) |
| [`docs/milestones.md`](docs/milestones.md) | the verified milestone record (S0 → C3) |
| [`docs/consumers.md`](docs/consumers.md) | the polymorph adoption track: jco blocker mapping, cutover evidence, in-repo ports |
| [`docs/references.md`](docs/references.md) | canonical upstream links (spec, JSPI, wasmtime internals, toolchain pins) |
| [`contracts/`](contracts/) | versioned interface contracts — [plan format](contracts/plan-format.md), [descriptor IR](contracts/descriptor-ir.md), [intrinsics](contracts/intrinsics.md), [digest](contracts/digest.md), [embedder API](contracts/embedder-api.md) |
| [`AGENTS.md`](AGENTS.md) | development protocol and the full gate list |
| [issue tracker](https://github.com/lann/deltic/issues) | open and deferred work |

[polymorph]: https://github.com/polymorph-components

---

<sub><i>125% more engine!</i></sub>
