# Embedder API conventions (host-facing)

Status: **v0.2 — C1 deliverable (docs/milestones.md), normative for the C2
implementation; amendment A1 (2026-08-10) makes sync-import suspension a
declared, per-function capability (`suspending()`), replacing v0.1's
undeclared "permitted cast"; amendment A2 (2026-08-10) extends A1 to
host-resource methods/statics (class-prototype authority), adds the
stage-3 decorator form, and makes interface members receive their
containing object as `this`; amendment A3 (2026-08-11) lets `instantiate`
accept untranslated artifacts (`{ componentBytes, translator }`) and run
the translation internally; amendment A4 (2026-08-11) blesses the
translation envelope as the build-time artifact
(`artifactsFromEnvelope`); amendment A5 (2026-08-11) makes host wrapping
of one stream/future idempotent (pass-through round trips —
host→guest→host — hand back the same handle machinery instead of
asserting), legalizes host↔host rendezvous for every element type, and
pins u8 stream chunks as `Uint8Array` in both directions; amendment A6
(2026-08-11) ships the wasi-shims parking kernel always-on (§"WASI
examination", renumbered from a colliding second "A5"); amendment A7
(2026-08-11) makes component faults loud on host stream/future
operations (`PeerTrappedError`, never a hang or a fake end-of-stream)
and limits host ends to one in-flight operation per direction; amendment
A8 (2026-08-10, deltic#90/#97) makes `Future.drop()` before writing an
**abandonment** (total, never-throwing; a guest reader observes a trap at
its rendezvous, never DROPPED) and documents host `cancelRead` as
indistinguishable from end-of-stream by design.** This document supersedes `descriptor-ir.md`'s interim
"host value mapping" table as the destination for host-facing value shapes.
The runtime's *raw* boundary (`instance.exports`, `HostImports`) keeps the
`definitions.py` interpreter shapes as an **internal** surface; the
conventions below are implemented by the bindgen-generated ergonomic layer
(see "Implementation strategy"). Reference consumers: the polymorph host
modules (`webrtc.js`, `webcrypto.js`, `websocket.js`) and the C2 WASI shim
package. Design evidence: `tools/smoke-c0/REPORT.md` §"C1 design-input
notes" (friction findings 1–8), the R-fix review's stream-API advisories,
and docs/consumers.md.

## Principles

1. **Fresh design; jco compatibility is a non-goal** (docs/architecture.md §2). Where jco's
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

Version resolution follows the Component Model's **canonical interface
names** design and wasmtime's linker semantics — see "Version
canonicalization" below. What remains banned is *unversioned* folding
(C0 finding D-1's actual defect: version-agnostic keys merged distinct
semver tracks). Helpers may expand a wildcard over interface *names*
within one track, never across tracks.

## Version canonicalization

> Correction (same day as v0.1): the initial draft ruled "version-exact
> keys, never fuzzy-matched." That was stricter than both authorities and
> would have forced the C2 shim to triplicate implementations the
> ecosystem expects to unify. Authorities: Explainer.md §"canonical
> interface names" (`canonversion`, 🔗-gated) and wasmtime's
> `wasmtime-environ::component::names::{NameMap, alternate_lookup_key}`
> (used by both `component::Linker` and `Component::get_export`).

Every version belongs to a **compatibility track**, per the spec's
canonicalization split (identical to wasmtime's `alternate_lookup_key`):

| version | track key | notes |
|---|---|---|
| `1.2.3`, `1.0.0`, `2.1.2+abc` | `@1`, `@1`, `@2` | major > 0 → major is the track |
| `0.2.6`, `0.2.12` | `@0.2` | major 0 → minor is the track |
| `0.0.1` | none | patch-only versions are compatible with nothing |
| any prerelease (`0.2.0-rc-…`) | none (resolution) | wasmtime treats prereleases as exact-only; the historical WASI `0.2.0-rc` snapshots differed at the same track, which is D-1's phenomenon with a tag |

**Resolution rule (normative for `instantiate` and the C2 shim):** an
import name is matched (1) **exactly** against provided entries, then
(2) against the provider registered for the import's *track*, where a
track slot is claimed by the **highest-versioned** entry registered on
that track (wasmtime's max-wins rule). Structural type-checking of the
resolved instance does the real safety work — backwards *and* limited
forwards compatibility fall out of "the guest only uses functions the
provider actually has", exactly as the spec describes.

**Registration forms (providers):** register full-versioned keys
(`…/monotonic-clock@0.2.12` — track alternate derived automatically), or
register the **track key itself** (`…/monotonic-clock@0.2`) as an
explicitly canonical provider serving the whole track. Registering both
a track key and full-versioned keys on the same track is refused at
registration (ambiguity is an error, not a precedence rule).
**Unversioned interface ids** (C2 amendment) are legal exact-match keys —
unversioned WIT interfaces exist — but an unversioned key never serves a
versioned import nor vice versa; only *folding* (treating an unversioned
key as a cross-track wildcard) is banned.

**What this resolves from C0:** D-2 (p2 at `0.2.6`/`0.2.9`/`0.2.12`) —
one `@0.2` provider serves all three, as WASI intends. D-1
(`monotonic-clock@0.3.0` naming different function sets across artifact
families) — same track, divergent drafts: served by a **union** provider,
with per-leaf structural resolution selecting what each component
actually imports; no version machinery can or should distinguish them.

**Forward note (wasmtime-bump era):** the 🔗 canonical-names feature puts
`canonversion` in binaries with the split-off `versionsuffix` carried as
a separate field on imports/exports; wasmparser 0.252 predates it.
When the pin moves: the plan format gains an optional `versionSuffix` on
import/export entries, and resolution degenerates to the trivial string
equality the spec intends (note `semver::Version::parse("0.2")` fails, so
canonical names never generate alternates — the two mechanisms compose
without interference).

## Value mapping (normative)

| Component type | TS type | Notes |
|---|---|---|
| `bool` | `boolean` | |
| `u8 s8 u16 s16 u32 s32 f32 f64` | `number` | range-checked at lower |
| `u64 s64` | `bigint` | range-checked at lower |
| `char` | `string` (single code point) | validated at lower |
| `string` | `string` | lower applies USVString replacement (docs/architecture.md §7) |
| `list<u8>` | `Uint8Array` | always a copy; never a view into guest memory |
| `list<T>` (T ≠ u8) | `T[]` | plain arrays; no typed-array widening (a future perf opt-in, never a silent shape change) |
| `tuple<A, B, …>` | `[A, B, …]` | real TS tuple |
| `record` | plain object, camelCase fields | fields of option type are optional properties: lift emits **absent** (not `undefined`-valued) for none; lower accepts either spelling (C2 amendment) |
| `enum` | string literal union of kebab-case case names | `"offer" \| "answer" \| …` |
| `variant` | `{ tag: "case" }` \| `{ tag: "case", val: T }` | `val` **absent** (not `undefined`) for payloadless cases |
| `option<T>` | `T \| undefined`; **nested** options box | see rule below |
| `result<T, E>` **as a value** (nested in other types, or in parameter position) | `{ tag: "ok", val: T } \| { tag: "err", val: E }` | `val` absent for empty sides — same family as `variant` |
| `result<T, E>` **as a function result** (return position only) | return `T` / throw `WitError<E>` | empty sides: resolves `undefined` / `WitError.payload === undefined`; see "Error model" |
| `map<K, V>` | its despecialization `list<tuple<K, V>>` → `[K, V][]` | C2 amendment |
| `flags` | object of camelCase booleans | lift: every flag present; lower: absent = `false` |
| `own<R>` / `borrow<R>` | the resource class instance | see "Resources" |
| `stream<T>` / `future<T>` / `error-context` | `Stream<T>` / `Future<T>` / `ErrorContext` | see "Streams and futures" |

**Terminology note.** The spec calls variant alternatives **cases**
(Explainer, definitions.py `case_label`); prose here follows that. The
discriminant *property* is nonetheless named `tag`, a deliberate
divergence: "tagged union" is the JS/TS-side term of art, `{ tag, val }`
is the established convention in this exact niche (jco, and the consumer
host modules already written against it), and `case` is a JS reserved
word — legal as a property, but `v.case` reads like syntax. The value of
`tag` is always the case name, kebab-case verbatim.

**Why a discriminant property rather than `{ [case]: value }`** (the
single-key form the internal definitions.py-shaped boundary uses):
(1) exhaustiveness — `switch (v.tag)` + `assertNever` is compiler-checked
case coverage; `in`-chains are not switchable and lose it; (2) payloadless
cases get one uniform shape (`val` absent) instead of a null/undefined
sentinel adjacent to `option` payloads; (3) generic code reads `v.tag`
typed and allocation-free where single-key needs an untypeable
`Object.keys(v)[0]` cast, and per-case key shapes make every
variant-touching site polymorphic for the engine; (4) case names stay
data (kebab-case verbatim) rather than entering the identifier-casing
regime as keys. Conceded cost: literal construction is wordier —
bindgen may emit per-variant constructor helpers (`Message.binary(bytes)`)
as an optional nicety; the value shape is unaffected.

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
class PeerTrappedError extends Error {  // A7: a stream/future op whose peer instance trapped
  readonly cause: unknown;      // chains to the Trap
  readonly progress?: number;   // write ops: elements delivered before the fault
}
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
  traps poison the instance per docs/architecture.md §7 regardless.
- **`Trap.message` is diagnostic text, not API.** Match on the `Trap`
  brand (or future structured fields), never on message text. In
  particular, a raw core-wasm trap (e.g. `unreachable`) carries the
  *engine's own* wording behind a `guest trapped:` provenance prefix —
  V8, SpiderMonkey, and JSC each phrase the same trap differently, and
  the runtime deliberately does not normalize them (the conformance
  harness reconciles suite-expected wording at comparison time instead;
  see `TRAP_MESSAGE_EQUIVALENTS` in harness/src/runner.ts). Runtime-
  *authored* traps (FACT adapter codes, deadlock detection, handle-table
  errors) have stable wording chosen by this project, but the same rule
  applies: text is for humans and logs.
- Results nested inside values never throw anywhere — they are plain
  `{ tag, val }` data (table above).

## Functions and async

- **Exports are uniformly Promise-shaped**: bindgen types every export as
  returning `Promise<T>`, sync-typed or not (a sync completion resolves
  immediately). One calling convention; async-first per docs/architecture.md §1. Exactly
  two exceptions (C2 amendments): resource constructors (synchronous —
  see Resources) and `future<T>`-typed results (eager handles — see
  Streams and futures).
- **Imports match their WIT type**: an `async func` import may be a plain
  `async` JS function (or return a value synchronously); a sync `func`
  import is typed to return `T` synchronously. Returning a Promise from a
  sync-typed import parks the calling **wasm frame** and is a *declared*
  capability (amendment A1): wrap the function in `suspending()` (exported
  from the embedder surface). The marker
  - is per-declaration — only marked imports are handed to wasm as
    `WebAssembly.Suspending`, so unmarked imports keep the plain calling
    convention and sync-only components keep their zero-cost pin;
  - is auto-detection evidence — a marked import selects jspi mode without
    an explicit `jspi: true` (an explicit `jspi: false` still forces plain,
    where a returned Promise is refused as before);
  - carries real costs, deliberately visible: every call through a marked
    import pays the engine's continuation hop even when it returns
    synchronously (`contracts/intrinsics.md` pin (j)), and a marked import
    reached from a `start` function traps (pin (c): a start function may
    not block — the trap fires even for synchronous returns);
  - rides the engine floor: on a non-JSPI engine a marked import that
    returns a Promise is refused at the call site (`NeedsJspi`), never
    silently degraded.
  Scope (as extended by A2): plain function imports (bare and interface
  members), host-resource **methods and statics** — mark instance methods
  on the class (the CLASS PROTOTYPE is the per-declaration brand
  authority, read at wrap time; instance-level overrides change the
  dispatched body, never suspendability), statics on the function itself.
  Constructors are never markable (synchronous by the C2 amendment). Two
  spellings, one brand: the direct call (`f: suspending(fn)` — canonical,
  the only form available in record literals) and a stage-3 method
  decorator (`@suspending` on instance or static methods). The decorator
  refuses non-method positions and the legacy `experimentalDecorators`
  calling convention loudly, at class-definition time. Semantics of the
  park: the reference's `thread.wait_until(subtask.resolved)`
  (definitions.py canon_lower) — a plain non-cancellable wait; the
  instance-entry gate stays held (the #43 hold rule); result lowering runs
  at resume time under the suspension point's attribution claim.
- **Interface members are invoked with their containing object as
  receiver** (A2): a class instance is a fully supported spelling of an
  interface provider — methods reading instance state work, matching the
  resource static arm's behavior. World-level bare imports have no
  containing object and are called unbound.
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
(docs/architecture.md §7). Passing an instance where `own<R>` is expected **invalidates
the wrapper** (further use throws); passing as `borrow<R>` leaves it
usable after the call returns.

**Host-implemented resources** (guest holds handles): the host provides a
plain class implementing the bindgen-emitted interface (camelCase methods;
statics as static members; the WIT constructor as the JS constructor). The
runtime owns the instance↔rep mapping. When the guest drops its last own
handle, the runtime calls `instance[Symbol.dispose]?.()` (dtor). Method
`self` is the instance — no reps, no side tables.

**Constructors are synchronous** (C2 amendment): a JS class constructor
cannot await, so `new R(...)` is the one exception to Promise-shaped
exports. A guest constructor that does not complete synchronously raises
a named error rather than half-constructing; if a consumer ever needs a
suspending constructor, the escape hatch is a generated async static
factory — deferred until demanded.

Ownership at the boundary, both directions:

| WIT position | guest-implemented R | host-implemented R |
|---|---|---|
| host receives `own<R>` | new class instance (host now owns; drop/`using` it) | the host's own instance back; the guest's handle is gone; no dispose call |
| host receives `borrow<R>` | instance valid **only during the call** (retention throws) | the host's own instance; borrow scoping is guest-side bookkeeping |
| host passes `own<R>` | wrapper invalidated (transferred) | instance registered; guest owns its handle |
| host passes `borrow<R>` | wrapper stays valid | guest must not retain past the call (runtime-enforced per CABI); a never-registered instance gets a rep allocated for the call's duration (C2 amendment) |

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
class ErrorContext { readonly message: string }  // lift-only: no host constructor (C2 amendment); lowering accepts only lifted instances
class DroppedError extends Error { … }    // awaiting a dropped future rejects with this
```

- **Future results are eager handles** (C2 amendment): an export whose WIT
  result is `future<T>` returns `Future<T>` **directly**, not
  `Promise<Future<T>>` — JS promise resolution unconditionally adopts
  thenables, so a Promise can never resolve *to* a PromiseLike handle;
  wrapping would make `drop`/`cancel` unreachable. `await exportFn()`
  still yields `T` (the handle is thenable); call without awaiting to
  hold the handle. Streams are unaffected (`Stream` is not thenable).
- **Lifted** `stream<T>`/`future<T>` values arrive as `Stream<T>`/
  `Future<T>`. Awaiting a future whose write end dropped without a value
  rejects with `DroppedError` (discriminated — R-fix review note 4).
- **Lowering accepts the natural JS producers**: where the guest expects a
  `stream<T>`, the host may pass a `ReadableStream`, an `AsyncIterable`,
  an array (finite), or a `Stream<T>` handle; for `future<T>`, a
  `Promise<T>` or `Future<T>`. Bindgen adapts and **owns the pumping**:
  the driving arms auto-close on end/`DROPPED` (eliminating the
  deadlock-masking activity-lifetime footgun — R-fix review note 2), and
  cross-store reuse is a runtime-asserted error, not silent misbehavior
  (note 3).
- **Stream values survive round trips** (amendment A5). A `stream`/`future`
  is an identity: lifting one that the host already handled — a
  host-created stream a guest passed back (result or import position), or
  a guest-created stream on its second hop — is **idempotent**, yielding a
  handle over the same underlying end rather than the v0.2
  double-wrap error. Consequences, all normative:
  - host → guest → host pass-through works with the guest never reading;
    the payload then moves host↔host without touching guest memory;
  - a readable end may hop the boundary any number of times (each lower
    transfers it, exactly as between two guests);
  - host↔host rendezvous is legal for **every** element type — the
    same-instance restriction applies to component instances only;
  - a `Stream.create()` writer keeps feeding the same stream across hops
    (the writer half addresses the shared end, not a particular handle).
- **u8 chunks are `Uint8Array` in both directions** (amendment A5, the
  write-side mirror of `Chunk<u8>`): `StreamWriter.write`/`writeAll` take
  `Chunk<T>`, and a `Uint8Array` chunk is treated as already-lowered bytes
  — passed by reference to the rendezvous (borrowed until the returned
  promise settles) and copied exactly once, at the rendezvous itself.
  Reads hand back that copy unchanged: one copy end-to-end for
  host↔host, one memory copy each way when a guest is the peer.
- Writer-side host ends (`hostStream()`-era API) remain the low-level seam
  underneath; the conventions layer exposes them as
  `Stream.create<T>(): { stream: Stream<T>, writer: StreamWriter<T> }`
  with `write`/`writeAll`/`cancelWrite`/`close`.
- **Component faults are loud on stream/future operations** (amendment
  A7). When the component instance holding the peer end traps, its live
  ends are retired: a parked host `read`/`write`/`writeAll`/future-await
  **rejects with `PeerTrappedError`** (`cause` chains to the trap; a
  write's `progress` reports elements delivered before the fault), and so
  does any operation started afterwards. A fault is never presented as a
  clean end-of-stream or a bare `DroppedError` — the same
  no-wrong-data-as-success rule the producer direction has
  (`StreamProducerError`) — with one precision: an operation that
  genuinely COMPLETED before the trap keeps its result (a full write, a
  read that copied data), and the fault surfaces on the export call and
  on the handle's next operation. A trapping host **import** drops the
  lifted stream/future arguments it abandoned, so their peers settle with
  the truthful short count / end-of-stream. Only embedder negligence —
  lowering a host end and never acting on it — still hangs, as documented
  since v0.2.
- **One in-flight operation per host end, per direction** (amendment A7):
  a second `write` while one is parked (or a second `read`, or a second
  future operation) throws a `TypeError` synchronously — the host-side
  spelling of the `CopyEnd` busy trap. Reading while a write is parked on
  the same stream stays legal (they are different ends). Previously the
  second operation could "rendezvous" against the first one's parked
  buffer and report data as taken by a peer that never existed.
- **Dropping an unwritten future is abandonment, not DROPPED** (amendment
  A8, deltic#90). The CABI forbids a writable future end from dropping
  before delivering its value (definitions.py:1183-1184) — a guest doing
  so traps. The host-side spelling: `Future.drop()`/`[Symbol.dispose]` on
  a **lowered**, never-written future never throws and is idempotent; the
  guest-held readable end observes a **trap at its rendezvous point**
  ("the host dropped the writable end without writing a value") — pending
  read, later read, or waitable-set delivery alike — never a DROPPED
  event (which the CABI says a future reader cannot see) and never a
  hang. An unlowered future (the guest never saw it) just releases state.
  Producer failures (`Promise` rejection under `lowerFutureSource`) keep
  their A7-era reporting: the in-flight call fails site-named via the
  host-failure channel.
- **`cancelRead` is indistinguishable from end-of-stream — by design**
  (amendment A8, deltic#97). A host-side `Stream.cancelRead()` settles the
  in-flight `read` with an empty chunk, which `readable()`/the async
  iterator present as clean EOS. The canceller is the same code observing
  the end, so no discriminated signal is warranted; pinned by test. (A
  *peer* fault is never presented this way — that is A7's rule.)

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
- **Untranslated artifacts** (A3): `instantiate` also accepts
  `{ componentBytes, translator }` where `translator` is the
  translator-shim wasm bytes or a shared `Translator` instance, and
  translates internally — bytes in, instance out. Prefer the shared
  instance across several instantiations (the wasm compile is the cost
  worth sharing; warm translation is sub-millisecond).
  `requiredImports` still takes a plan: translate explicitly to inspect
  the import surface before instantiating.
- **Build-time translation** (A4): the translation ENVELOPE (the
  single-file JSON from `Translator.translateRaw` / the `tools/translate`
  CLI, carrying plan + FACT adapters) is the blessed deploy artifact —
  production ships `component.wasm` + envelope + runtime, no translator.
  `artifactsFromEnvelope(envelopeJson, componentBytes)` reconstitutes
  `ComponentArtifacts`; the envelope's embedded component sha-256 is
  verified at instantiation, so a mismatched deploy pair fails loudly.
  Fetch-agnostic by design: the embedder acquires the two blobs.
- **Per-interface module authoring** (the consumers' file layout) is a
  helper over the same record: a module's named export, camelCase of the
  interface short-name, provides that interface
  (`export const connections = { Websocket }` in websocket.js survives
  as-is). The helper expands `"ns:pkg/*@0.2": mod` wildcards over
  interface *names only*, at a single version or track key; resolution
  across versions is solely the canonicalization rule above (never
  unversioned folding).
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

Per the operator ruling (docs/architecture.md §2 / docs/consumers.md): implementations stay out of core,
but the conventions must make WASI interfaces natural. Idiomatic
signatures for the representative slice:

**wasi:clocks/monotonic-clock@0.3.0** (p3; C0-proven shape):

```ts
{ now(): bigint; getResolution(): bigint;
  waitUntil(when: bigint): Promise<void>;   // async func → async method
  waitFor(howLong: bigint): Promise<void> } // 4 lines over setTimeout; zero JSPI
```

**wasi:io@0.2.x pollable + streams** (p2): `pollable.block()`, `poll()`
and `blocking-read`/`blocking-write-and-flush` are **sync** WIT functions
that must park — the one p2 idiom that fights a JS host. The shim package
ships the PARKING KERNEL, always on (amendment A6, 2026-08-11;
supersedes the original three-tier ruling and its "never (c) in this
package" mission line — the polymorph-iroh upstream-iroh consumer class
genuinely parks, which the always-ready stubs turned into a livelock):
`block`/`poll` are `suspending()`-marked (A1/A2) with sync fast paths, so
a ready pollable costs one engine hop and only a genuine wait parks the
frame. Timer pollables are real (monotonic-clock subscribe-*). On engines
without JSPI, `chooseMode` degrades to plain and a genuine park raises a
clean `NeedsJspi` at the park site instead of livelocking; `jspi: false`
is the per-instantiation opt-out. Streams stay buffer-backed (sync
`read`/`check-write` never park — sufficient for every known consumer).
`Pollable` is publicly constructible — `new Pollable(ready, wait)` — as
the interop seam for external providers (e.g. consumer-side sockets glue)
whose pollables the kernel `poll()`s uniformly; `wait()` follows the
promise-swap producer shape (settle + re-arm per event; spurious wakes
fine). Consequence for the M2 zero-cost pin: a component importing marked
providers auto-detects into jspi mode on JSPI engines even if it never
parks — "zero-cost plain path" now reads "sync-only plan AND no marked
imports" (see contracts/intrinsics.md). A pollable is a
thin class over host-supplied readiness:

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
become the module-mapping helper, with version handling per "Version
canonicalization" (semver-track resolution, matching wasmtime's linker
— strictly more capable than jco's exact `--map` keys).

## C2 implementation requirements (normative checklist)

1. Version resolution per "Version canonicalization": exact-first, then
   track-alternate with max-wins; prerelease and `0.0.z` exact-only;
   track-key registration supported; same-track mixed registration
   refused; **unversioned folding banned** (C0 D-1). The shim ships one
   provider per track (`@0.2`, `@0.3`), union-shaped where consumer
   drafts diverge within a track.
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
   check that the conventions serve WASI (docs/consumers.md).
