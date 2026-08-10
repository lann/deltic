# kitchen-sink — a representative tour of the embedder API

One world exercising the surfaces an embedder actually touches:

| surface | WIT | guest | host |
|---|---|---|---|
| enum / record / variant / flags | `types` interface | `describe`, `classify`, `scale`, `allowed` | §4 |
| outermost `option` → `undefined \| T` | `find` | | §5 |
| return-place `result` → resolve / throw `WitError` | `lookup` | | §5 |
| nested option/result as plain data + the boxing rule | `survey`, `maybe-maybe` | | §5 |
| host-implemented imports: sync, fallible, **suspending** | `notify` interface | `run-batch` | §2 |
| host-implemented resource (ctor / method / static / dispose) | `notify.channel` | `run-batch` | §3 |
| guest-implemented resource (`using`) | `api.counter` | `Counter` | §6 |

Run it:

```sh
just shim          # once, from the repo root: builds the translator
./run.sh           # builds the guest component, runs the host
```

What to notice:

- **The guest cannot tell which imports suspend.** `read-sensor` and
  `channel.send` are sync WIT functions; the host implements them with
  Promises and marks them — `suspending(fn)` (call form) and
  `@suspending` (decorator on the class method). The guest's Rust is
  oblivious; its wasm frame parks on JSPI and resumes. Marking has costs
  (a continuation hop per call, illegal from `start` functions) — see
  the §2c comment in [`host.ts`](host.ts).
- **Match errors on the brand, never the message.** `lookup`'s err side
  arrives as a thrown `WitError` with `.payload`; any *unbranded* throw
  from a host import is a host bug and traps the component.
- **The option rule is per-chain.** An option inside a `list` is still
  the outermost of its own chain (`undefined | T`); boxing to
  `{ tag: "some" | "none" }` happens only for option directly inside
  another option — `maybe-maybe` pins all three depths.
- **Resources are classes on both sides.** The host's `Channel` class is
  handed over as-is (the runtime calls `[Symbol.dispose]` when the guest
  drops its handle); the guest's `counter` comes back as a constructible
  class the host can `using`-scope.

Deliberately absent (to stay approachable): streams/futures and async-typed
functions — see `contracts/embedder-api.md` §"Streams and futures" until an
example covers them.

The authoritative reference is
[`contracts/embedder-api.md`](../../contracts/embedder-api.md); if this
example and the contract disagree, the contract wins (and the example's
self-checks should have caught it — run them).
