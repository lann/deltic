# C0 — Consumer smoke test: report

Exit artifact for PLAN.md §13 row C0 (adoption track §17). Evidence-gathering
only: no `runtime/`, `crates/`, `harness/`, `contracts/` or `PLAN.md` code was
changed by this track. Everything below is reproducible from
`tools/smoke-c0/`.

- Host: Deno 2.9.5 (aarch64-unknown-linux-gnu), V8 15.0.245.2, TypeScript 6.0.3
- Translator shim: `shimVersion 0.1.0`, `wasmtimeEnviron 47.0.3`, features
  `cm-async, cm-async-stackful, cm-more-async-builtins, cm-error-context,
  cm-fixed-length-lists, cm-map, cm-implements, cm-threading`
- component-engine commit: `5f7868c`
- wasm-tools CLI 1.247.0 (cross-check only)

## Headline

| Leg | Subject | Verdict |
|---|---|---|
| 1 | `compose-async-tdz` (lann/jco#51 shape) | **PASS** — `run() -> ok(42)` through the fused async cross-component call |
| 2 | iroh `exec-model` probe (lann/jco#11 shape) | **PASS with 2 named xfails** — probes 1/2/3/5 pass; the detached-pump deadlock jco cannot survive is cleared; guest→host streaming blocked on runtime findings R-1/R-2 |
| 3 | Translator throughput, 6-artifact corpus to 10.5 MB | **PASS** — 6/6 accepted, zero rejections; 10.5 MB in 73 ms warm |
| 4 | polymorph-websocket conformance suite (translate-only) | **PASS** — 3/3 accepted; C2 shim shopping list enumerated |

Two genuinely new runtime defects were isolated (R-1, R-2), both with minimal
repros. **Zero** translator rejections across nine real consumer components —
which materially changes the wasmtime pin-bump argument (see below).

---

## Leg 1 — `compose-async-tdz`, the lann/jco#51 shape

Command: `deno run --allow-read leg1_tdz.ts` → **PASS** (all assertions).

Artifact: `experiment-mosh/spikes/compose-async-tdz/composed.wasm`, a `wac`
composition of `tdz:plug` (async factory returning `own<widget>`) into
`tdz:socket` (async export awaiting it) whose world *also* exports a `handoff`
interface naming that same resource in a signature. That combination is jco's
exact TDZ trigger: the emitted trampoline references a resource class above its
declaration.

Expected values were read from source, not guessed:

- `plug/src/lib.rs`: `make() -> Ok(Widget::new(WidgetRes(42)))`
- `socket/src/lib.rs`: `run() -> Ok(make().await?.poke())` ⇒ `ok(42)`

Observed:

```
plan: modules=8 (embedded=6 adapter=2) initializers=41 trampolines=64
      types=34 imports=19 exports=2
worldDigest: sha256:34af61379c7bac044cee6d90c42ac5dc59ef4b2dd56cb2144407318863342243
exports: instance tdz:socket/driver, instance tdz:socket/handoff
run() = {"ok":42}
stats: {"liftedCalls":1,"tasksResolved":1,"enterSyncCalls":1,"exitSyncCalls":1}
```

Assertions, all PASS:

1. translate accepted (no error envelope)
2. exports the `driver` interface
3. exports the `handoff` interface — **the resource re-export that is jco#51's trigger**
4. 2 FACT adapters emitted (the fused cross-component call — jco#14's shape)
5. instantiate succeeded (there is no emission step for a TDZ to exist in)
6. `run()` returned a Promise (it parked on the cross-component async call)
7. `run() -> ok(42)`
8. no libc-baseline import fired during the call

Notes:

- **The digest guard did not refuse this shape.** The dispatch anticipated that
  `worldDigest` computation might decline for multi-resource shapes; it did
  not — a digest was produced. Nothing depends on it here, but the expectation
  should be relaxed.
- `handoff.accept(w: widget)` is **not host-callable** and was not called:
  `widget` is defined by the plug instance and is not exported by the composed
  world, so a host cannot mint one. Its presence is the trigger; its
  callability is not part of the shape. Asserted structurally instead (#3).
- The composed component carries **19 imports** none of which appear in either
  WIT world — the whole Rust `wasm32-wasip2` libc baseline at
  **`@0.2.6`**. All 19 were satisfied by loud stubs; assertion #8 proves none
  fired. "Two tiny components, no shims" (PLAN.md §13 C0) is true of the WIT
  but not of the binary.

## Leg 2 — iroh `exec-model`, the lann/jco#11 kill shot

Command: `deno run --allow-read leg2_exec_model.ts` → **PASS with 2 named xfails**.

Artifact: `polymorph-iroh/target/wasm32-wasip2/release/iroh_exec_model_guest.wasm`.
Guest source: `polymorph-iroh/experiments/exec-model/guest/src/lib.rs`. jco
reference driver: `polymorph-iroh/host-jco/src/run-exec.mjs`.

### Ground truth on the import surface

The WIT world declares exactly one import (`wasi:clocks/monotonic-clock@0.3.0`).
The binary carries **31**, per `plan.imports` (the version-matched authority):

| Interface | Leaves |
|---|---|
| `polymorph:webcrypto/key-agreement@0.1.0` | `[constructor]agreement-key-options`, `.can-derive-bits`, `.can-derive-key`, `.extractable`, `[method]public-key.export-key-raw`, resources `agreement-key-options`/`public-key`/`secret-key` |
| `polymorph:webcrypto/x25519@0.1.0` | `generate-key` |
| `wasi:clocks/monotonic-clock@0.3.0` | `wait-for` |
| `wasi:clocks/monotonic-clock@0.2.9` | `subscribe-duration` |
| `wasi:cli/{environment,exit,stdin,stdout,stderr,terminal-*}@0.2.9` | 10 leaves |
| `wasi:io/error@0.2.9`, `wasi:io/poll@0.2.9`, `wasi:io/streams@0.2.9` | 9 leaves incl. `pollable`/`input-stream`/`output-stream` resources |

The webcrypto imports are **not** in the WIT world at all — they arrive through
the guest's `polymorph_webcrypto_guest` crate dependency under `generate_all`.
Any C2 shim list derived from WIT alone would have missed them entirely.

`wasm-tools component wit` cross-check **agrees** (it did not fail on this
encoding). It additionally lists `wasi:clocks/types@0.3.0` and
`polymorph:webcrypto/types@0.1.0`, which are type-only instance imports and
correctly carry no runtime items in `plan.imports`. Benign, not a discrepancy.

### Host glue written for this leg

14 leaves implemented, 19 stubbed. Real implementations:

- `wasi:clocks/monotonic-clock@0.3.0 wait-for` — an async host function
  (`Promise` + `setTimeout`). **No JSPI involved**: the runtime's
  Promise-returning-import path parks the callback-ABI task. This worked
  exactly as advertised and was the single most frictionless part of the leg.
- `polymorph:webcrypto/x25519 generate-key` + `key-agreement` resources —
  backed by Deno's own WebCrypto X25519, so the guest's `block_on` bridge
  drives a genuinely async host import.
- `wasi:cli` stdio + `wasi:io/streams` writes — real enough to surface a guest
  panic rather than swallow it. (No panic occurred; stdio log stayed empty.)

### Probe results, in the diagnostic order

```
probe 1  blockon-in-spawn()  PASS  ok(string) in 3.3 ms
         guest: "block_on inside spawn (export live): x25519 ok, pub[0..4]=…"

probe 2  start-pump()        PASS  returned in 0.6 ms
         PASS  returned BEFORE the pump's 50 ms wait-for completed
               — the detached task is demonstrably still in flight

probe 3  poll-pump()         PASS  ok(string) in 58.4 ms
         guest: "block_on in detached pump (no export live): x25519 ok, …"
         ^^ THIS IS THE KILL SHOT. Under jco this call never executes its
            first wasm slice (lann/jco#11 = polymorph-iroh#10).

probe 4a open-stream(5000,1000) read to completion   XFAIL [R-1]
         host read 1000/5000 bytes in 1 read, then stalled (5 s timeout)

probe 4b open-stream(100000,1000), drop reader       XFAIL [R-2]
         unreachable: the first call rejects with the hostFailure that
         4a's abandoned drain parked

probe 5  sink-stream(<host stream, 500 bytes>)       PASS
         guest counted 500 bytes in 14.6 ms
```

Probe 2's timing assertion is the load-bearing one: `start-pump` returned in
0.6 ms while the pump's first act is `wait_for(50 ms)`, so the detached task
was provably still parked when the export call resolved — and probe 3 then ran
to completion anyway. **PLAN.md §17's first blocker row is now executable
evidence, not a claim.**

`stats: liftedCalls=6, tasksResolved=6, loweredCalls=20, callbackInvocations=21`;
4 guest resource drops observed through host dtors.

### Findings R-1 and R-2

Minimal repro: `deno run --allow-read repro_stream_pump.ts`.

**R-1 — a host read of a guest stream stalls when the guest's writer is parked
on a Promise-returning host import and no export call is in flight.**
Triage: **runtime bug**.

The `open-stream` shape is: return a `stream<u8>` immediately, fill it from a
*detached* task that awaits `wait-for` between chunks. The host then reads
between export calls. Observed: the first (already-buffered) chunk arrives, the
second read never resolves.

Mechanism, with sites:

- `runtime/src/exec/boundary.ts:1393-1416` — a Promise-returning lowered import
  registers its promise in `store.pendingHostCalls`; on settle it calls
  `onResolve`, which readies the guest thread but **does not tick the store**.
- `runtime/src/exec/boundary.ts:614+` — only `driveAsync` races
  `pendingHostCalls` and re-pumps, and `driveAsync` exists only for the
  duration of an export call.
- `runtime/src/exec/host_streams.ts:161-175` — `HostActivity.pump()` is the
  designated between-export-calls driver, and its own docstring names this
  exact hazard ("a guest parked in a background forwarding task would never be
  resumed … and the host read would await forever") — but it only drains
  `store.awaiting` (the JSPI park set). It has **no arm for
  `pendingHostCalls`**.

The repro includes a discriminator that isolates the cause: run **C** supplies
the same `wait-for` as a *synchronous* host function (returns `null`, not a
Promise), so the writer never parks on a host promise — and the identical read
loop then completes **5000/5000 bytes**. Async host-import parking is the
trigger, conclusively.

```
A. no export call in flight        read#0 -> 1000 bytes; read#1 TIMEOUT   (bug)
B. with an export call in flight   read#0 -> 1000 bytes; read#1 TIMEOUT   (confounded by R-2)
C. wait-for returns synchronously  read#0..4 -> 1000 each, read#5 -> 0 = 5000/5000  (clean)
```

Run B was intended as the control but is confounded: the concurrent export call
dies of R-2 first, so it neither confirms nor refutes the "driveAsync would
have pumped it" half of the diagnosis. Recorded honestly; run C carries the
argument instead.

Consumer impact: this is precisely polymorph-iroh's production shape (a
detached pump feeding an exported stream) and therefore squarely on the C3
critical path.

**R-2 — check-then-act race across an `await` in `HostActivity.#drainAsync`.**
Triage: **runtime bug**.

`runtime/src/exec/host_streams.ts:180-198`:

```ts
while (store.awaiting.size > 0) {
  await Promise.resolve();          // line 184 — suspends
  if (store.serviceSettled()) { …; continue; }
  const t = [...store.awaiting][0]; // line 193 — set may now be EMPTY
  store.awaiting.delete(t);
  const p = t.awaiting!;            // line 198 — TypeError on undefined
}
```

The loop guard is evaluated before the `await`; the set can be emptied while
the drain is suspended, after which `[...set][0]` is `undefined`. Observed
verbatim:

```
TypeError: Cannot read properties of undefined (reading 'awaiting')
    at HostActivity.#drainAsync (runtime/src/exec/host_streams.ts:198:21)
```

The failure is caught into `store.hostFailure` and then surfaced by the *next,
unrelated* export call — so one stalled host stream poisons the instance for
everything after it. That blast radius is the report-worthy part; the fix
itself is a one-line re-check (`if (store.awaiting.size === 0) continue;`).

## Leg 3 — Translator throughput

Command: `deno run --allow-read leg3_throughput.ts` → **PASS**, 6/6 accepted,
**zero rejections**.

| artifact | bytes | cold ms | warm ms (×3) | envelope B | verdict |
|---|---:|---:|---|---:|---|
| `compose-async-tdz/composed.wasm` | 149,776 | 35.8 | 2.7 / 2.5 / 2.5 | 28,516 | ACCEPTED |
| `iroh_exec_model_guest.wasm` | 166,046 | 2.8 | 1.7 / 2.0 / 1.8 | 21,750 | ACCEPTED |
| `engine-go/main.wasm` (componentize-go) | 8,056,403 | 78.6 | 54.7 / 54.4 / 54.0 | 44,709 | ACCEPTED |
| `client-core/composed-client.wasm` (3-component wac) | 10,543,458 | 76.8 | 75.0 / 73.2 / 73.3 | 200,946 | ACCEPTED |
| `proxy/composed-proxy.wasm` | 2,518,662 | 19.2 | 18.7 / 18.6 / 18.7 | 150,640 | ACCEPTED |
| `iroh_endpoint.wasm` | 1,970,030 | 13.7 | 13.3 / 13.3 / 13.1 | 73,487 | ACCEPTED |

Plan shapes (accepted):

| artifact | modules (emb/adapter) | initializers | trampolines | types | imports | exports |
|---|---|---:|---:|---:|---:|---:|
| compose-async-tdz | 8 (6/2) | 41 | 64 | 34 | 19 | 2 |
| exec-model guest | 3 (3/0) | 28 | 50 | 26 | 31 | 1 |
| engine-go main | 5 (5/0) | 53 | 44 | 49 | 42 | 2 |
| composed-client | (see leg3 transcript) | | | | | |
| composed-proxy | (see leg3 transcript) | | | | | |
| iroh_endpoint | 3 (3/0) | 67 | 121 | 83 | 69 | 1 |

The first cold number (35.8 ms) is dominated by shim wasm warm-up, not by the
input: the *second* artifact's cold pass is 2.8 ms. Steady-state is the warm
column.

### Multi-MB verdict

**Multi-MB is a non-issue.** Against the M0 datum (94 KB / 28 ms ≈ 3.4 MB/s),
warm steady-state now runs at roughly **60 MB/s for componentize-go's 8 MB
artifact and 144 MB/s for the 10.5 MB composed client** — the largest consumer
artifact in the family translates in **73 ms**, ~2.6× the *time* M0 needed for
something 112× smaller. Envelope sizes stay modest (≤ 201 KB) because
`plan-format.md` decision #3 keeps embedded modules as byte ranges rather than
copies; envelope size tracks component *structure* (composed-proxy's 2.5 MB
produces a larger envelope than engine-go's 8 MB, because the 8 MB is mostly
one flat Go module). Nothing here motivates the postcard/custom-section
revisit that decision #2 held in reserve.

## Leg 4 — polymorph-websocket conformance suite (translate-only)

Command: `deno run --allow-read leg4_websocket.ts` → **PASS**, 3/3 accepted.

The composed suite artifact was **already built** in the consumer tree
(`conformance/driver-ct/justfile` target `compose-suite`), so this leg only read
it — no `cargo`, `wac`, or `just` was run anywhere near those trees.

| artifact | bytes | cold ms | warm ms | envelope B | shape |
|---|---:|---:|---|---:|---|
| bare suite (`websocket` imported) | 528,239 | 41.9 | 5.9/4.5/4.5 | 27,152 | 3 mod (3/0), 35 init, 59 tramp, 34 imports |
| composed suite (provider + TLS plugged) | 2,980,212 | 29.6 | 22.3/21.4/21.2 | 99,603 | 11 mod (9/2), 86 init, **200 tramp**, 34 imports |
| websocket guest provider | 598,621 | 5.3 | 4.6/4.4/4.6 | 43,824 | 3 mod (3/0), 38 init, 86 tramp, 38 imports |

Both export exactly `instance polymorph:test/tests@0.1.0`.

### C2 shim shopping list

**Bare suite** — what a JS-side websocket shim must provide, and nothing more:

- `polymorph:websocket/connections@0.1.0` — resource `websocket` +
  `[static]websocket.connect`, `[method]websocket.{send, receive,
  send-via-stream, receive-via-stream, state, protocol, close, wait-closed}`
  (**9 leaves — this is the whole C2 websocket surface**)
- `polymorph:test/test-context@0.1.0` — resource `context`
- p2 baseline `@0.2.9`: `wasi:cli/{environment,exit,stdin,stdout,stderr,
  terminal-input,terminal-output,terminal-stdin,terminal-stdout,terminal-stderr}`,
  `wasi:clocks/{monotonic-clock (now, subscribe-duration), wall-clock (now)}`,
  `wasi:io/{error, poll (pollable, poll, pollable.block), streams
  (input-stream, output-stream, write, check-write, blocking-flush, subscribe)}`

**Composed suite** — websocket is satisfied in-guest; what remains is the
Deno-native leg's surface:

- `polymorph:test/test-context@0.1.0` — resource `context`
- p2 baseline `@0.2.12` (cli, clocks, io, **plus `wasi:random/{random,
  insecure-seed}`**)
- **p3 sockets**: `wasi:sockets/types@0.3.0` — resource `tcp-socket`,
  `[static]tcp-socket.create`, `[method]tcp-socket.{connect, send, receive}`;
  and `wasi:sockets/ip-name-lookup@0.3.0 resolve-addresses`
- `wasi:clocks/monotonic-clock@0.3.0` — `now`, **`wait-until`**

**Guest provider** additionally needs `polymorph:tls/client@0.1.0` (resource
`connector`: constructor + `connect`/`send`/`receive`) and
`polymorph:tls/types@0.1.0` (resource `error` + `to-debug-string`).

Sizing note for C2: the p3 TCP socket surface is **5 leaves**, not the p2
socket sprawl. A Deno-native websocket leg is a genuinely small shim.

---

## Discrepancy table (triaged)

| # | Finding | Class | Evidence |
|---|---|---|---|
| **R-1** | Host read of a guest stream stalls when the guest writer is parked on a Promise-returning host import with no export call in flight | **runtime bug** | `repro_stream_pump.ts` runs A (stall at 1000/5000) vs C (5000/5000 with a synchronous import). Sites: `boundary.ts:1393-1416` (registers in `pendingHostCalls`, never ticks), `host_streams.ts:161-175` (`pump()` drains only `store.awaiting`) |
| **R-2** | `HostActivity.#drainAsync` re-indexes `store.awaiting` after an `await` without re-checking emptiness; the resulting `TypeError` is parked in `store.hostFailure` and surfaces on a later, unrelated export call | **runtime bug** | `TypeError: Cannot read properties of undefined (reading 'awaiting')` at `host_streams.ts:198:21`; guard at line 180, suspension at line 184, faulting index at line 193 |
| **D-1** | `wasi:clocks/monotonic-clock@0.3.0` exposes **different functions at the same version string**: `wait-for` (iroh + experiment-mosh family) vs `now` + `wait-until` (polymorph-websocket family) | **toolchain drift** | leg3: exec-model / composed-client / composed-proxy / iroh_endpoint all import `wait-for`. leg4: composed suite and guest provider both import `now`,`wait-until`. Version string identical |
| **D-2** | The p2 baseline arrives at **four different versions across one consumer family**: `@0.2.6` (compose-async-tdz), `@0.2.9` (exec-model, bare websocket suite), `@0.2.12` (engine-go, composed websocket suite, guest provider) | **toolchain drift** | leg3 + leg4 import surfaces |
| **C-1** | Declared WIT world ≠ linkable import surface. exec-model's world declares 1 import; the binary needs 31, incl. `polymorph:webcrypto/*` pulled in transitively by a guest crate under `generate_all` | **conventions gap** | leg2 "GROUND TRUTH" section; corroborated by `wasm-tools component wit` |
| **C-2** | Even "no shims" components need the full libc baseline satisfied at instantiate time. compose-async-tdz declares zero WASI in either world and still requires 19 leaves (all unused at runtime — assertion #8) | **conventions gap** | leg1; the executor fails at instantiate on any missing leaf (by design — `plan-format.md` "Executor obligations") |
| **C-3** | `result<T,E>` lifts to a single-key object `{ok: …}` / `{err: …}`, which is neither a `{tag,val}` variant nor a bare payload. Undocumented in the contracts read for this track | **conventions gap** | leg1: `run() = {"ok":42}`. C1 (`embedder-api.md`) owns this |
| **M-1** | No missing shims blocked any leg. Everything the corpus imports was either implementable in a few lines of Deno or correctly stubbable | **missing shims: none blocking** | leg2 (14 leaves implemented by hand), leg4 (surface enumerated) |
| **T-1** | **Zero** translator rejections across nine real consumer components spanning wit-bindgen 0.60-era Rust, componentize-go, and 2-/3-component `wac` compositions | **toolchain drift: none observed** | leg3 (6/6), leg4 (3/3) |

Notably **absent**: any `PendingCapability`, `NeedsJspi`, or
`UnsupportedFeatureError` was raised anywhere in this track. The only
`TranslateError` phases exercised were… none, because nothing was rejected.

## wasmtime pin-bump recommendation

**Do not bump the wasmtime pin for C0. Decouple the bump from the consumer
track and schedule it on its own evidence.**

The C0 exit criterion frames the bump as a decision "made on the drift
evidence", with the side benefit of retiring M2's 47 wasmparser pin-drift
xfails. The drift evidence came back empty in the direction that matters:

- **9/9 consumer artifacts translated clean at `wasmtime-environ 47.0.3`** —
  including componentize-go output, three `wac` compositions, and the p3
  stream/future-bearing exec-model guest. No `unsupported` phase, no
  `validation` phase, no `internal` phase.
- Every drift we *did* observe (D-1, D-2) is **WIT-level drift in the
  consumers' own toolchains**, not encoding drift our wasmparser cannot read. A
  wasmtime bump does not address D-1 or D-2; only versioned shim dispatch does
  (see C2 note below).
- The two defects that actually block a consumer workload (R-1, R-2) are in
  `runtime/src/exec/`, entirely ours, and a pin bump is irrelevant to both.

So the bump's remaining justification is exactly what it was before C0 — the
47-xfail wasmparser pin-drift class in the M2 suite — with **no added consumer
pressure and one new argument against urgency**: 47.0.3 is now known-good
against the entire real consumer corpus, which is a property worth not
perturbing while R-1/R-2 are being fixed and C1/C2 are being designed against
this exact behavior. Recommendation: bump after C2's shim package lands and
before C3 cutover, re-running `tools/smoke-c0/leg3_throughput.ts` and
`leg4_websocket.ts` as the regression gate (they are cheap — ~1.5 s and ~1 s —
and they now have a zero-rejection baseline to diff against).

## C1 design-input notes

Written while building Leg 2's glue by hand; these are friction reports, not
proposals.

**1. Host resources are raw integers, and the host must invent its own
identity.** `hostResourceType({name, dtor})` establishes the *type*, but every
own/borrow at the boundary is a bare `number` rep. Implementing
`key-agreement` meant hand-rolling three side tables (`optsTable`, `pubTable`,
`secTable`) plus a `nextRep` counter, and manually deleting from `optsTable`
when `generate-key` consumed its `own` argument. Verbatim friction: *there is
no way to hand the runtime a JS object and get a handle back* — the identity
mapping is entirely the embedder's problem, repeated per interface. C1's
"resource classes" should own this: a host resource should be a JS class whose
instances the runtime maps to reps, with `own` transfer visible in the type.

**2. Ownership transfer is invisible at the boundary.** Nothing in the host
signature distinguishes `own<agreement-key-options>` from
`borrow<public-key>`; both arrive as `number`. I only knew to free the options
object by reading `x25519.wit`'s prose ("`input` is consumed"). A host that
guesses wrong leaks or double-frees silently.

**3. Method dispatch is flat, string-keyed, and mangled.** Leaves arrive as
`"[method]agreement-key-options.can-derive-bits"`,
`"[constructor]agreement-key-options"`, `"[static]websocket.connect"` — the
host object must literally have those keys. Writing them by hand is
error-prone enough that I built `wasi_stub.ts` to synthesize the whole tree
from `plan.imports` rather than transcribe it. C1's "module-per-interface
authoring" should let a host write a class with a `canDeriveBits` method and
have bindgen do the mangling.

**4. Version strings in import keys are a real ergonomic tax (and D-1 makes it
a correctness tax).** Import names embed `@0.2.9` etc., so the same host
implementation cannot serve two components in the corpus without duplication. I
worked around it with version-stripping keys in `wasi_stub.ts` — which is
*wrong in general*, and D-1 proves it: `monotonic-clock@0.3.0` means two
different function sets in two artifact families. C2's shim package needs
explicit per-version implementations with a dispatch layer, not
version-agnostic matching. **This is the single most concrete C2 requirement
this track produced.**

**5. The Promise-returning-import path is excellent and needs no redesign.**
`wait-for` was four lines and worked first try, with no JSPI, under a
callback-ABI guest, inside a detached task. Async host imports are the part of
the boundary that already feels finished. Keep the shape; C1 should just name
it.

**6. p2 pollables were never actually needed.** Despite `wasi:io/poll`
appearing in every single import surface, no leg ever had a `pollable` method
called — the p2 pollable surface is present because Rust's libc baseline links
it, not because guests drive it. Stubbing the resource type was sufficient
everywhere. C2 should not front-load a real pollable implementation.

**7. Value-shape pain.** Two shapes cost debugging time: `result` lifting to
`{ok}`/`{err}` (C-3 — I initially asserted `{tag, val}` and got a spurious
FAIL), and `tuple<secret-key, public-key>` lowering as a plain array `[sec,
pub]` inside `{ok: […]}`, which is easy to confuse with a `list`. Both are
reasonable choices; neither is written down where a host author would look.
C1's variant/option/result/enum section should lead with a worked example of a
nested shape like `result<tuple<own<r>, own<r>>, error>`.

**8. `plan.imports` is the right authority and should be a supported embedder
tool.** Building the import object mechanically from the plan was far more
reliable than reading WIT (C-1) and faster than `wasm-tools` (which does not
distinguish type-only imports from linkable ones). A blessed
"enumerate-required-imports" API would save every future embedder the same
work.

## Artifact provenance

Consumer repos (state at time of run; **unchanged before and after** — see
gates):

| repo | commit | worktree |
|---|---|---|
| `polymorph/experiment-mosh` | `45d48e6` | 5 pre-existing modified files (not touched by this track) |
| `polymorph/polymorph-iroh` | `d01b85d` | clean |
| `polymorph/polymorph-websocket` | `2edbf4f` | clean |

| artifact | bytes | sha256 |
|---|---:|---|
| `experiment-mosh/spikes/compose-async-tdz/composed.wasm` | 149,776 | `f7269e6930a9e9988ffc7278ee7c87e29064709cbf04c22771b9c04ddc6348bf` |
| `polymorph-iroh/target/wasm32-wasip2/release/iroh_exec_model_guest.wasm` | 166,046 | `221bac8c1a4510a15883862766a0bb29374dd1147e9e1387d4b6fa075e59d0a4` |
| `experiment-mosh/engine-go/main.wasm` | 8,056,403 | `d234c17710e2fa71a05e32712117e618530a982fad12408000e0acf211c255c1` |
| `experiment-mosh/client-core/composed-client.wasm` | 10,543,458 | `1cff75843f7224a68ee9c793cc0829134f95b555c07ee31c8c0563934cbf4866` |
| `experiment-mosh/proxy/composed-proxy.wasm` | 2,518,662 | `97aa7e0c998572fbcd37c5b53c8f6b280e9b9c197315a5ebf7499c2292d79351` |
| `polymorph-iroh/target/wasm32-wasip2/release/iroh_endpoint.wasm` | 1,970,030 | `ff8a95b3b197d3b4d473c4d0f732010c90645db034a3959fe1d19ab7ceed2479` |
| `polymorph-websocket/.../release/conformance_guest_ct.wasm` | 528,239 | `79f7b0abc5b25fd91f3cda05b5025cf30f7bd3420bd8135ffeb15f33f1cd4163` |
| `polymorph-websocket/.../release/composed/conformance_guest_ct.wasm` | 2,980,212 | `ed3ad617665c45194e2c1f096476029fcb531e3a12b3426bc35f8604faed9043` |
| `polymorph-websocket/.../release/websocket_guest_provider.wasm` | 598,621 | `87e5be2a72a7feef1666c67be66f82a7037e02ffb6f8f91d1c39a3b649c327dc` |

## Gates

| # | Command | Outcome |
|---|---|---|
| 1 | `git -C …/experiment-mosh status --short` (+ iroh, websocket), before and after | **PASS** — byte-identical. mosh: same 5 pre-existing `M` entries; iroh and websocket: empty both times |
| 2 | `deno check *.ts` in `tools/smoke-c0` | **PASS** — 6/6 files clean (the "not a member of the workspace" notice is the expected standalone-`deno.json` warning, per `tools/probes/webrtc-deno`) |
| 3 | each leg via `deno run` | **PASS** — leg1 PASS; leg2 PASS with 2 named xfails (exit 0); leg3 PASS; leg4 PASS; repro reproduces R-1 and R-2 |
| 4 | `cd runtime && deno task test` | **PASS** — `ok | 224 passed | 0 failed | 3 ignored (1s)`, `EXIT=0` |
| 5 | `git status --short` in component-engine | **PASS** — `?? tools/smoke-c0/` only |

## Remaining work / handoff

- **R-1 and R-2 are unfixed by design** (this track gathers evidence; it does
  not touch `runtime/`). Both have deterministic repros in
  `repro_stream_pump.ts`. R-1 gates the polymorph-iroh C3 cutover.
- Leg 2 probes 4a/4b are wired as `xfail(…, "R-1"/"R-2", …)` and will print
  `PASS … [R-1 appears FIXED — retighten this leg]` once the defects are
  fixed. That is the intended regression signal; the leg should then be
  tightened back to hard `check`s.
- Run B of `repro_stream_pump.ts` (the "driver in flight" control) is
  confounded by R-2 and should be re-run once R-2 is fixed, to confirm the
  second half of R-1's diagnosis.
- Not attempted: executing the websocket conformance suite (Leg 4 was
  translate-only per its best-effort scope) and executing the multi-MB
  composed-client / engine-go artifacts. Leg 3 establishes only that they
  translate.
