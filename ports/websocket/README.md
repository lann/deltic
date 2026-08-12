# `ports/websocket` — the `polymorph:websocket` host module

The consumer host module for `polymorph:websocket/connections@0.1.0`,
ported to the deltic embedder conventions
(`contracts/embedder-api.md`), plus the runner that executes the
consumer's **real** conformance suite under deltic.

This package is deliberately **not** a member of the root Deno workspace
(like `tools/smoke-c0`): it imports the runtime, `wasi-shims` and
`ct-runner` by relative path. The "not a member of the workspace" warning
Deno prints is benign.

## Tasks

| task | what it does |
|---|---|
| `deno task check` | type-check `src`, `tests`, `conformance` |
| `deno task test` | unit tests against a local Deno echo server |
| `deno task conformance` | build+spawn the consumer's `conformance-echod`, then run all 54 suite cases through `ct-runner` |

## Provenance

- Contract: `polymorph-websocket/wit/websocket.wit`.
- Behavioral reference: `polymorph-websocket/js/jco/websocket.js` — the
  browser-first host the consumer's suite asserts. `src/websocket.ts`
  preserves its logic line-for-line (cited as `websocket.js:LINE`) and
  translates only the conventions:
  bare-payload throws → `ComponentException`, jco `Stream` → `Stream<T>` /
  `ReadableStream`, `--map` module wiring → `websocketImports()`,
  module-level setters → `configure()` **plus** the compatible
  `setMaxInboundBufferBytes` / `setConnectTimeoutMs` /
  `setCloseTimeoutMs` spellings.
- Runner reference: `conformance/driver-ct/jco/run-node.mjs` — the same
  bounds (256 KiB inbound buffer, 5 s connect, 3 s close), the same
  `WS_CONFORMANCE_*` environment, the same echod spawn contract.

## Behavioral delta vs. `websocket.js`

Exactly one, and it is a **runtime** difference, not a design choice:

- **Abnormal-closure close code.** Browsers and Node deliver
  `CloseEvent.code === 1006` when the peer drops TCP with no close frame;
  **Deno delivers `0`**. Both mean "no close frame was received", so the
  port treats `{0, 1006, 1015}` as the synthesized set that maps to
  *no* `close-info`. `1005` is deliberately excluded — it is the
  legitimate observation of a code-less close frame, which the suite
  asserts. See `#settleClosed` for the full note.

Everything else — buffered-amount polling, the connect/close bounds, the
overflow-close rule, the receive-via-stream single-use rule — behaves
identically on Deno.

## Consumer tree hygiene

Nothing here writes into `polymorph-websocket`. The `conformance-echod`
build redirects `CARGO_TARGET_DIR` to `/tmp/opencode/c3-ws-target` and
passes `--locked`; the suite artifact and the test PKI are read-only
inputs.
