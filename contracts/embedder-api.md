# Embedder API conventions (host-facing)

Status: **v0.1 — C1 deliverable (PLAN §13), normative for the C2
implementation.** This document supersedes `descriptor-ir.md`'s interim
"host value mapping" table as the destination for host-facing value shapes.
The runtime's *raw* boundary (`instance.exports`, `HostImports`) keeps the
`definitions.py` interpreter shapes as an **internal** surface; the
conventions below are implemented by the bindgen-generated ergonomic layer
(see "Implementation strategy"). Reference consumers: the polymorph host
modules (`webrtc.js`, `webcrypto.js`, `websocket.js`) and the C2 WASI shim
package. Design evidence: `tools/smoke-c0/REPORT.md` §"C1 design-input
notes" (friction findings 1–8), the R-fix review's stream-API advisories,
and PLAN §17.

## Principles

1. **Fresh design; jco compatibility is a non-goal** (PLAN §2). Where jco's
   choice is also the right choice (camelCase, `{tag, val}` variants), we
   converge by merit — deliberately, so consumer ports stay small.
2. **Footguns are design defects.** Every convention here is judged against
   the defensive code the polymorph modules had to write under jco
   (bare-payload error throws, convention-only stream contracts,
   hand-transcribed mangled keys).
3. **One way to do each thing.** No dual error channels, no alternative
   value spellings. Liberal *acceptance* is allowed only where the TS type
   still names a single canonical form.
4. **TS-first.** Every shape must be expressible as a precise TypeScript
   type that bindgen can emit; discriminated unions over clever encodings.
5. **WASI interfaces must come out natural.** The conventions are validated
   on paper against wasi p2/p3 idioms (appendix) — the ecosystem's most
   important interfaces, and what every adopter's shims will be written
   against.
6. **Async is the point.** Exports are uniformly Promise-shaped; async host
   imports are plain async functions (C0 finding #5: that path "already
   feels finished" — it is named here and frozen).

## Naming and casing

| WIT construct | JS/TS |
|---|---|
| function, method, static, record field, flag name, function param (docs only — calls are positional) | camelCase (`get-resolution` → `getResolution`) |
| resource name | PascalCase class (`tcp-socket` → `TcpSocket`) |
| enum value, variant/result tag | **kebab-case verbatim** as string literals (`connection-refused`) — they are data, not identifiers |
| interface key in the imports/exports record | fully-qualified WIT id **verbatim, version included**: `wasi:clocks/monotonic-clock@0.3.0` |
| world-level (bare) imports/exports | camelCase name at the record's top level |

Version strings are never stripped or fuzzy-matched (C0 finding D-1:
`monotonic-clock@0.3.0` names *different function sets* in different
consumer artifact families — version-agnostic matching is a correctness
bug, not an ergonomic shortcut). Serving multiple versions means providing
multiple explicit entries; helpers may *expand* a wildcard over interface
names within one exact version, never over versions.

## Value mapping (normative)

| Component type | TS type | Notes |
|---|---|---|
| `bool` | `boolean` | |
| `u8 s8 u16 s16 u32 s32 f32 f64` | `number` | range-checked at lower |
| `u64 s64` | `bigint` | range-checked at lower |
| `char` | `string` (single code point) | validated at lower |
| `string` | `string` | lower applies USVString replacement (PLAN §7) |
| `list<u8>` | `Uint8Array` | always a copy; never a view into guest memory |
| `list<T>` (T ≠ u8) | `T[]` | plain arrays; no typed-array widening (a future perf opt-in, never a silent shape change) |
| `tuple<A, B, …>` | `[A, B, …]` | real TS tuple |
| `record` | plain object, camelCase fields | fields of option type are optional properties (`field?: T`) |
| `enum` | string literal union of kebab tags | `"offer" \| "answer" \| …` |
| `variant` | `{ tag: "case" }` \| `{ tag: "case", val: T }` | `val` **absent** (not `undefined`) for payloadless cases |
| `option<T>` | `T \| undefined`; **nested** options box | see rule below |
| `result<T, E>` **as a value** (nested in other types) | `{ tag: "ok", val: T } \| { tag: "err", val: E }` | `val` absent for empty sides — same family as `variant` |
| `result<T, E>` **as a function result** | return `T` / throw `WitError<E>` | see "Error model" |
| `flags` | object of camelCase booleans | lift: every flag present; lower: absent = `false` |
| `own<R>` / `borrow<R>` | the resource class instance | see "Resources" |
| `stream<T>` / `future<T>` / `error-context` | `Stream<T>` / `Future<T>` / `ErrorContext` | see "Streams and futures" |

**Option rule.** The *outermost* option in a chain maps to
`T | undefined`; every option nested **directly inside another option**
uses the variant family: `{ tag: "some", val: … } | { tag: "none" }`.
Only option maps to `undefined`, so this is the only ambiguity and the
boxing is exactly as deep as needed. Example (`option<option<u32>>`, the
values-fixture Some(None) edge):

```ts
undefined                          // none
{ tag: "none" }                    // some(none)
{ tag: "some", val: 7 }            // some(some(7))
```

**Worked example** (C0 finding #7 asked for exactly this shape) —
`result<tuple<own<counter>, own<counter>>, error>`:

- as a **function result**: the call resolves to `[Counter, Counter]`
  (a real two-element tuple of class instances, ownership transferred to
  the caller), or rejects/throws `WitError` whose `.payload` is the
  `error` variant value, e.g. `{ tag: "timed-out" }`.
- **nested as a value** (say inside `list<…>`):
  `{ tag: "ok", val: [Counter, Counter] } | { tag: "err", val: Error… }`.

## Error model

```ts
class WitError<E = unknown> extends Error {
  readonly payload: E;          // the WIT err value, shaped per the table
  constructor(payload: E, message?: string);
}
class Trap extends Error { … }  // existing; component-fatal, never a value
```

- **Guest export with `result<T, E>`**: the call resolves to `T` on ok and
  rejects (throws, for sync paths) with `WitError<E>` on err. `Trap`
  rejections are always distinguishable by class.
- **Host import with `result<T, E>`**: the host function returns `T` for
  ok and `throw`s `new WitError(payload)` for err — the ergonomic
  throw-for-error pattern, **branded**.
- **An unbranded throw from a host import is a host bug and becomes a
  trap** (with a message naming the import), never a guest-visible err —
  the inversion of jco's convention, where any stray `TypeError` was fed
  to the lift and the polymorph modules had to wrap every platform call
  defensively (`platformCall` in webcrypto.js). Here the defensive wrapper
  is unnecessary by construction: only `WitError` crosses as an err value.
- Host code must never catch-and-swallow `Trap` (re-throw if observed);
  traps poison the instance per PLAN §7 regardless.
- Results nested inside values never throw anywhere — they are plain
  `{ tag, val }` data (table above).

## Functions and async

- **Exports are uniformly Promise-shaped**: bindgen types every export as
  returning `Promise<T>`, sync-typed or not (a sync completion resolves
  immediately). One calling convention; async-first per PLAN §1.
- **Imports match their WIT type**: an `async func` import may be a plain
  `async` JS function (or return a value synchronously); a sync `func`
  import is typed to return `T` synchronously. Returning a Promise from a
  sync-typed import is *permitted* but rides JSPI (engine floor caveat) —
  bindgen's types make that a visible, deliberate cast.
- Params are positional; param names appear only in types/docs (they are
  excluded from the world digest — `contracts/digest.md`).

## Resources

Two directions, one surface: **a resource is a class instance on both
sides of the boundary.** The C0 friction findings 1–3 (bare-number reps,
hand-rolled identity tables, hand-transcribed `[method]…` keys) are
resolved here by making identity mapping and name mangling bindgen/runtime
obligations, never the embedder's.

**Guest-implemented resources** (host holds handles): bindgen emits a
class per resource — constructor calls the guest constructor; methods and
statics camelCase; `[Symbol.dispose]()` and `drop()` both drop the handle
(TS `using` works); a `FinalizationRegistry` backstop drops leaked handles
(PLAN §7). Passing an instance where `own<R>` is expected **invalidates
the wrapper** (further use throws); passing as `borrow<R>` leaves it
usable after the call returns.

**Host-implemented resources** (guest holds handles): the host provides a
plain class implementing the bindgen-emitted interface (camelCase methods;
statics as static members; the WIT constructor as the JS constructor). The
runtime owns the instance↔rep mapping. When the guest drops its last own
handle, the runtime calls `instance[Symbol.dispose]?.()` (dtor). Method
`self` is the instance — no reps, no side tables.

Ownership at the boundary, both directions:

| WIT position | guest-implemented R | host-implemented R |
|---|---|---|
| host receives `own<R>` | new class instance (host now owns; drop/`using` it) | the host's own instance back; the guest's handle is gone; no dispose call |
| host receives `borrow<R>` | instance valid **only during the call** (retention throws) | the host's own instance; borrow scoping is guest-side bookkeeping |
| host passes `own<R>` | wrapper invalidated (transferred) | instance registered; guest owns its handle |
| host passes `borrow<R>` | wrapper stays valid | guest must not retain past the call (runtime-enforced per CABI) |

## Streams and futures

Handles, not raw shared objects (`SharedStreamImpl` identity stays
internal):

```ts
interface Stream<T> {
  readable(): ReadableStream<Chunk<T>>;    // web-native; Chunk<u8> = Uint8Array, else T[]
  [Symbol.asyncIterator](): AsyncIterator<Chunk<T>>;
  read(max: number): Promise<Chunk<T>>;    // low-level; empty chunk = end
  cancelRead(): void;
  drop(): void;                            // [Symbol.dispose] alias
}
interface Future<T> extends PromiseLike<T> {  // await it directly
  drop(): void; cancel(): void;
}
class ErrorContext { readonly message: string }
class DroppedError extends Error { … }    // awaiting a dropped future rejects with this
```

- **Lifted** `stream<T>`/`future<T>` values arrive as `Stream<T>`/
  `Future<T>`. Awaiting a future whose write end dropped without a value
  rejects with `DroppedError` (discriminated — R-fix review note 4).
- **Lowering accepts the natural JS producers**: where the guest expects a
  `stream<T>`, the host may pass a `ReadableStream`, an `AsyncIterable`,
  an array (finite), or a `Stream<T>` handle; for `future<T>`, a
  `Promise<T>` or `Future<T>`. Bindgen adapts and **owns the pumping**:
  the driving arms auto-close on end/`DROPPED` (eliminating the
  deadlock-masking activity-lifetime footgun — R-fix review note 2), and
  double-wrap / cross-store reuse are runtime-asserted errors, not silent
  misbehavior (note 3).
- Writer-side host ends (`hostStream()`-era API) remain the low-level seam
  underneath; the conventions layer exposes them as
  `Stream.create<T>(): { stream: Stream<T>, writer: StreamWriter<T> }`
  with `write`/`writeAll`/`cancelWrite`/`close`.

## Module wiring and instantiation

Canonical form — one nested record, keyed by verbatim interface id:

```ts
const instance = await instantiate(artifacts, {
  "wasi:clocks/monotonic-clock@0.3.0": { now, getResolution, waitFor, waitUntil },
  "polymorph:websocket/connections@0.1.0": { Websocket },   // resource class
  // world-level bare imports at the top level, camelCase
});
```

- Bindgen emits the world's `Imports` type (this record, fully typed) and
  `Exports` type; `instantiate` verifies the world digest
  (`contracts/digest.md`) before trusting either.
- **Per-interface module authoring** (the consumers' file layout) is a
  helper over the same record: a module's named export, camelCase of the
  interface short-name, provides that interface
  (`export const connections = { Websocket }` in websocket.js survives
  as-is). The helper expands `"ns:pkg/*@1.2.3": mod` wildcards over
  interface *names only* — the version is always exact (D-1).
- `requiredImports(artifacts)` is a supported embedder API enumerating the
  component's linkable import leaves with kinds and types (C0 finding #8:
  `plan.imports` proved the right authority; blessing it removes every
  future embedder's hand-rolled equivalent).

## Bindgen obligations (summary of what the above requires)

Per world: `Imports`/`Exports` types; resource classes (both directions);
`WitError` payload types per fallible function; value types per the
mapping table; the mangled-name assembly (`[method]r.f` ↔ `class` methods)
in both directions; stream/future adapters incl. pumping; the digest
handshake. The generated layer is an adapter over the runtime's raw
(definitions.py-shaped) boundary — see below.

## Implementation strategy (C2)

The ergonomic layer is generated code **on top of** the raw boundary; the
interpreter's internal shapes (single-key variants, `{some}/{none}`,
tuple-as-record) do not change in C2. Rationale: the raw shapes are pinned
by the reference-test ports and the conformance harness's value mapping —
converging the interpreter itself is a perf-track concern (P1's
descriptor-driven codegen can emit convention shapes directly, skipping
the adapter). Consequence: `instance.exports` stays internal-shaped and
documented as such; embedders use the bindgen layer (or accept the
internal surface with no stability promise).

## WASI examination (paper signatures)

Per the operator ruling (PLAN §2/§17): implementations stay out of core,
but the conventions must make WASI interfaces natural. Idiomatic
signatures for the representative slice:

**wasi:clocks/monotonic-clock@0.3.0** (p3; C0-proven shape):

```ts
{ now(): bigint; getResolution(): bigint;
  waitUntil(when: bigint): Promise<void>;   // async func → async method
  waitFor(howLong: bigint): Promise<void> } // 4 lines over setTimeout; zero JSPI
```

**wasi:io@0.2.x pollable + streams** (p2): `pollable.block()` and
`blocking-read`/`blocking-write-and-flush` are **sync** WIT functions that
must park — the one p2 idiom that fights a JS host. Three-tier strategy:
(a) default: type-only stubs — C0 finding #6: the entire corpus links
`wasi:io/poll` via the libc baseline yet **no leg ever called a pollable
method**; (b) buffer-backed streams: sync `read`/`check-write` serve from
host-side buffers filled by background pumps, so the sync fast path never
parks; (c) when a guest genuinely blocks: the Promise-from-sync-import
path rides JSPI (engine-floor caveat, visible in types). A pollable is a
thin class over a task-core waitable:

```ts
class Pollable { ready(): boolean; block(): void /* tier (c) only */ }
// wasi:io/poll@0.2.x  poll: (in: Pollable[]) => Uint32Array indices — Promise.race under the hood
class InputStream {
  read(len: bigint): Uint8Array;             // throws WitError<StreamError>
  blockingRead(len: bigint): Uint8Array;     // tier (b)/(c)
  subscribe(): Pollable;
  [Symbol.dispose](): void;
}
```

**wasi:sockets@0.3.0 TCP** (p3, from the C0 leg-4 shopping list — 5
leaves): resources with async methods and stream-shaped I/O map directly:

```ts
class TcpSocket {
  static create(af: "ipv4" | "ipv6"): TcpSocket;       // result → throw WitError<ErrorCode>
  bind(addr: IpSocketAddress): void;
  connect(addr: IpSocketAddress): Promise<void>;        // async func
  send(data: Stream<number>): Promise<void>;            // called once; stream drives the connection
  receive(): Stream<number>;                             // Uint8Array chunks
}
```

**wasi:http@0.3 handler sketch** (p3 draft): the shape lands fetch-like
with no impedance:

```ts
// export handle: async func(request: request) -> result<response, error-code>
exports["wasi:http/handler@0.3.0"].handle(req: Request): Promise<Response>
// Request/Response are resource classes; .body(): Stream<u8> (Uint8Array
// chunks); trailers as Future<Fields>; err → WitError<ErrorCode>.
```

**polymorph:webrtc-datachannels `data-channel`** (the consumer reference):

```ts
class DataChannel {
  send(msg: Message): Promise<void>;                    // throws WitError<WebrtcError>
  receive(): Promise<Message>;
  receiveViaStream(): Stream<StreamMessage>;            // record { kind, length, data: Stream<u8> }
  [Symbol.dispose](): void;
}
// Message = { tag: "binary", val: Uint8Array } | { tag: "string", val: string }
```

Verdict of the examination: nothing in p2/p3 requires a convention not
already in this document; the only genuine friction is p2's sync-blocking
idiom, addressed by the three-tier strategy and made visible in types.

## Migration notes for the polymorph modules (jco → this API)

Small by design: camelCase, `{tag, val}` variants, enum strings, flags
objects, and resource-classes-per-interface all carry over unchanged. The
real deltas: (1) err results are `throw new WitError(payload)` instead of
throwing the bare payload — and the defensive `platformCall`-style
wrappers can be deleted rather than ported; (2) jco `Stream` objects
(`read({count})`) become `Stream<T>`/`ReadableStream`; (3) nested results
read `{ tag: "ok" | "err", val }`; (4) transpile-time flags
(`--async-exports`/`--async-imports`, `check-flags.mjs`) have no
equivalent — asyncness comes from the binary; (5) `--map` wildcards
become the module-mapping helper with exact versions.

## C2 implementation requirements (normative checklist)

1. Version-exact import dispatch; no version-stripped matching anywhere
   (C0 D-1 — "the single most concrete C2 requirement").
2. `requiredImports()` public API over `plan.imports`.
3. Host-resource identity mapping (instance ↔ rep) in the runtime;
   `[Symbol.dispose]` dtor dispatch; ownership per the 2×4 table.
4. Stream/future conventions layer: producer adaptation, automatic
   pumping with auto-close on end/DROPPED, `cancelRead`/`cancelWrite`,
   `DroppedError`, double-wrap and cross-store asserts (R-fix review
   notes 1–4).
5. `WitError`/`Trap` branding at every host-import boundary; unbranded
   throw → trap naming the import.
6. Bindgen: `Imports`/`Exports` world types, resource classes both
   directions, mangled-key assembly, value types per the table.
7. WASI shim package (separate deliverable) implementing the p2 baseline
   (tier (a)/(b)) + p3 clocks against these conventions — the executable
   check that the conventions serve WASI (PLAN §17).
