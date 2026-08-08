# examples/ — Rust guest fixture corpus

Guest components built with **wit-bindgen** (the compatibility target of this
project, PLAN.md §1/§11). The future TS host runs these as its executable
wit-bindgen-compat claim. Each guest is a pure computational reactor — **no
WASI imports** — so componentization needs no wasip1 adapter.

## Corpus

| Component | World (WIT) | Exports | Size (release) |
|---|---|---|---|
| `hello.component.wasm` | [`guests/hello/wit/world.wit`](guests/hello/wit/world.wit) | `greet: func(name: string) -> string` | ~20 KB |
| `values.component.wasm` | [`guests/values/wit/world.wit`](guests/values/wit/world.wit) | 17 `echo-*` funcs, one per type shape: bool, u64, s64, f32, f64, char, string, record, variant, enum, flags, option, option-nested, result, list\<u8\>, list\<string\>, tuple | ~24 KB |
| `resources.component.wasm` | [`guests/resources/wit/world.wit`](guests/resources/wit/world.wit) | interface `counters`: `counter` resource (constructor, `increment`, `get`, static `merge`) + free funcs over own/borrow handles (`make-counter`, `sum-both`, `bump`, `consume`) + `live-counters` (observes destructor runs) | ~24 KB |
| `async-probe.component.wasm` | [`guests/async-probe/wit/world.wit`](guests/async-probe/wit/world.wit) | CM 0.3 async: `wait-then-double: async func` (yields once), `sum-stream: async func(stream<u32>)`, `future-add: async func(future<u32>, u32)` | ~57 KB |

Every `echo-*` function returns its input unchanged: the host asserts
roundtrip equality for arbitrary vectors (lift/lower tests). The `resources`
guest counts live instances so destructor invocation is observable from
outside (`live-counters`).

## Rebuild

```sh
./build.sh
```

Requires: Rust with the `wasm32-unknown-unknown` target, `wasm-tools` on
PATH. `wasmtime` optional (smoke run). Outputs go to `guests/build/`
(gitignored). Per guest the script runs:

1. `cargo build --release --target wasm32-unknown-unknown`
2. `wasm-tools component new <core>.wasm -o <name>.component.wasm`
3. `wasm-tools validate --features component-model[,cm-async]`
4. `wasm-tools component wit` (world round-trip sanity)

Each guest crate has an **empty `[workspace]` table** in its `Cargo.toml` (the
repo root cargo workspace does not include `examples/`), pins
`wit-bindgen = "=0.60.0"`, has a committed `Cargo.lock`, and uses a small
release profile (`opt-level = "s"`, `lto = true`, `codegen-units = 1`,
`panic = "abort"`, `strip = "debuginfo"`).

### Toolchain (validated against)

| Tool | Version |
|---|---|
| wit-bindgen (crate, proc-macro) | **0.60.0** (pinned `=0.60.0`) |
| Rust | 1.96.0 stable, target `wasm32-unknown-unknown` |
| wasm-tools CLI | 1.247.0 |
| wasmtime CLI (smoke run only) | 47.0.1 |

No extra tool installs needed: bindings come from the `wit_bindgen::generate!`
proc macro, not the wit-bindgen CLI.

## Async findings (feeds S0/M2 risk assessment)

**Status: CM 0.3 async guests build on stable Rust today; built and smoke-run
here.** Details:

- wit-bindgen 0.60.0 generates Component Model
  [async ABI](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Async.md)
  bindings on **stable** Rust (1.96). The crate's `async` cargo feature is a
  **default feature**; `generate!({ async: true })` or `async func` in WIT
  turns it on per export. No nightly, no CLI tools, no unstable rustc flags.
- WIT `async func`, `stream<T>`, `future<T>` all parse in the macro and
  round-trip through `wasm-tools component new` + `component wit` (wasm-tools
  1.247).
- Validation needs `--features component-model,cm-async` (wasm-tools names it
  `cm-async`; there are further `cm-async-stackful`/`cm-async-builtins`
  refinements, not needed for these guests). Without it, validation fails on
  `context.get` — proof the binary genuinely uses 0.3 async builtins.
- **Every async export is lifted with the stackless callback ABI**:
  `canon lift ... async (callback ...)`; core exports come in pairs
  `[async-lift]NAME` + `[callback][async-lift]NAME`. wit-bindgen's Rust
  backend never emits stackful async lifts, which matches PLAN §6's build
  order (task core + callback ABI first — JSPI paths are only needed for
  blocking sync-lowers over async, not to run these guests' exports).
- Canonical builtins used by the generated runtime: `task.return`,
  `task.cancel`, `waitable-set.{new,poll,drop}`, `waitable.join`,
  `context.{get,set}` (slot 0), and the full `stream.*`/`future.*` suites
  (new/read/write/cancel-read/cancel-write/drop-readable/drop-writable).
  Notably **no `canon yield`**: `wit_bindgen::yield_async()` is implemented
  via the callback return-code protocol, not the `yield` builtin.
- wasmtime 47.0.1 executes the async component with **default flags**
  (`wasmtime run --invoke 'wait-then-double(21)'` → `42`, including a real
  yield suspension + resume). Stream/future-typed exports can't be invoked
  from the CLI (WAVE has no stream/future literals) — they await the host
  harness.
- Guest-side helpers available for later corpus growth: `block_on`,
  `spawn_local` (feature `async-spawn`, adds `futures`), `yield_async`,
  `backpressure_inc/dec`, stream/future writer halves (`wit_stream::new()`,
  `wit_future::new()` in generated bindings).

## Notes for the host implementation

Shape of wit-bindgen 0.60 core modules (inspect: `wasm-tools print`):

- **String encoding is utf8** on every lift/lower
  (`string-encoding=utf8`); wit-bindgen Rust never emits utf16/latin1.
- Sync exports: `canon lift (core func $f) (memory $m) (realloc $cabi_realloc)
  string-encoding=utf8 (post-return $cabi_post_NAME)`. A `cabi_post_NAME`
  post-return is emitted **per export that returns indirect data** (e.g.
  `greet`, the string/list echoes); the host must call it after copying
  results out.
- Core module exports: the lifted funcs, `memory`, `cabi_realloc`, plus a
  versioned `cabi_realloc_wit_bindgen_0_60_0` alias; `__data_end`/
  `__heap_base` globals are exported too (ignorable).
- Sync guests (hello/values/resources) have **zero core imports**. The async
  guest imports only canonical intrinsics under module names `$root` /
  `[export]$root` (e.g. `[waitable-set-new]`, `[task-return]NAME`), which
  `wasm-tools component new` wires to canon builtins — still no WASI, no
  adapter.
- Resources: dtors are plain core funcs; dropping an own handle inside the
  guest (e.g. `consume`, `merge`) runs the dtor synchronously. Use
  `live-counters` to assert dtor runs from the host side.
- The wit-bindgen version and world are embedded in a custom section
  (`component-type:wit-bindgen:0.60.0:...:encoded world`) of the core module;
  `wasm-tools component new` consumes it (metadata produced with wasm-tools
  0.254 internals decodes fine with the 1.247 CLI).

### wasmtime CLI invocation notes

`wasmtime run --invoke '<wave-expr>' <component>` works for all scalar/
aggregate types (WAVE syntax: `some("x")`, `err("bad")`, `{read, exec}`,
`(9, "nine", 9.25)`, `label("hi")`). Limitations found: functions returning
**resource handles** trap the CLI's result printer (wasm-wave "unsupported
value type"), and stream/future arguments aren't constructible — both are
host-harness territory, not corpus defects.
