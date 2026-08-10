# hello-world — the smallest complete embedding

One exported function, no imports. Three files matter:

| file | role |
|---|---|
| [`wit/world.wit`](wit/world.wit) | the contract: `greet: func(name: string) -> string` |
| [`guest/src/lib.rs`](guest/src/lib.rs) | the Rust guest (wit-bindgen) implementing it |
| [`host.ts`](host.ts) | the host: translate → instantiate → call |

Run it:

```sh
just shim          # once, from the repo root: builds the translator
./run.sh           # builds the guest component, runs the host
```

What to notice:

- **Exports are Promise-shaped** — `await component.exports.greet(...)`
  even though this guest is synchronous. One calling convention for sync
  and async guests (contracts/embedder-api.md §"Functions and async").
- **Strings just work** — the guest returns a heap-allocated string; the
  canonical ABI's realloc dance is the runtime's problem, not yours.
- **The imports record is empty** — this world imports nothing. For the
  full imports story (interfaces, resources, error model, suspending
  imports) continue to [`../kitchen-sink`](../kitchen-sink).

The authoritative reference for everything the host sees is
[`contracts/embedder-api.md`](../../contracts/embedder-api.md).
