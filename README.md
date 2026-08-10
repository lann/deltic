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
| `ports/` | polymorph host-module ports (reference implementations pending upstreaming; the consumer exams retired upstream — docs/consumers.md) |

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

## Translating components

Running a component takes a translation (an execution plan + FACT adapter
modules). Three ways to get one:

| method | production ships | choose when |
|---|---|---|
| **build-time** — [`tools/translate`](tools/translate/) emits a single-file *envelope*; the host reconstitutes it with `artifactsFromEnvelope(envelope, componentBytes)` | component + envelope + runtime — **no translator** | you know your components at build time (most apps; the browser default — saves ~0.5 MB gzip and a compile per visitor). The envelope embeds the component's sha-256, so a stale pair fails loudly at instantiation |
| **runtime, packaged** — `defaultTranslator()` from [`@deltic/translator`](translator/), passed to `instantiate({ componentBytes, translator })` | your host + the translator asset (~1.85 MB raw, 520 KB gzip) | components arrive dynamically (plugin systems), or dev/server contexts where the asset size is irrelevant. Pair with the artifact cache (`@deltic/runtime/cache`) so each component translates once per client, not once per load |
| **runtime, explicit** — `Translator.create(bytes)` / `Translator.fromExports(ns)` from `@deltic/runtime/shim` | same, minus the packaged loader | you source the translator wasm yourself: custom delivery, one shared instance across many components, or cache keying via `buildHash` |

Translation itself is sub-millisecond warm in all three; the methods differ
only in *when* it runs and *what you deploy*. Worked code: the
[examples](examples/) use the packaged form, [`tools/translate`'s
README](tools/translate/README.md) shows the build-time deploy recipe, and
the full decision record is the design note on
[#16](https://github.com/lann/deltic/issues/16).

## Consuming the unstable prereleases

Every green `main` commit publishes
`@deltic/{runtime,translator,wasi-shims,ct-runner}` to JSR as
`0.1.0-pre.g<shorthash>` — the same short hash as the corresponding
`pre-<shorthash>` [GitHub release](https://github.com/lann/deltic/releases),
so a version names an exact commit. There is no stable line yet
([#16](https://github.com/lann/deltic/issues/16)): **pin exactly and bump
deliberately** (hash versions are not ordered, and plain semver ranges
never resolve to prereleases anyway).

```ts
import { instantiate } from "jsr:@deltic/runtime@0.1.0-pre.g66727e5/embedder";
import { defaultTranslator } from "jsr:@deltic/translator@0.1.0-pre.g66727e5";
```

Deno's [minimum-dependency-age](https://docs.deno.com/runtime/packages/supply_chain/#minimum-dependency-age)
gate (24 h by default) applies even to exactly-pinned prereleases, so a
fresh publish won't resolve on day zero. To consume same-day publishes
while keeping the gate for the rest of your graph, exempt the scope
(wildcard excludes work as of Deno 2.9):

```jsonc
// deno.json
{ "minimumDependencyAge": { "age": "P1D", "exclude": ["jsr:@deltic/*"] } }
```

(or `--minimum-dependency-age=0` for a one-off run).

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
