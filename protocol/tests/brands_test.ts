// Golden pin for the brand vocabulary (contracts/embedder-api.md §"Module
// identity and @deltic/protocol", amendment A9; issue #83).
//
// Every key string is pinned LITERALLY here on purpose: the brands are
// process-global registry symbols shared with copies this repo never sees, so
// renaming a key — or bumping a generation suffix — is a breaking ecosystem
// event, not a refactor. It must fail a test, loudly, right here.

import { assertEquals } from "./assert.ts";
import * as brands from "../src/brands.ts";
import { PROTOCOL_GENERATION, WitError } from "../src/mod.ts";

const EXPECTED: Record<string, symbol> = {
  "deltic.witError/1": brands.WIT_ERROR,
  "deltic.trap/1": brands.TRAP,
  "deltic.dropped/1": brands.DROPPED,
  "deltic.peerTrapped/1": brands.PEER_TRAPPED,
  "deltic.invalidHandle/1": brands.INVALID_HANDLE,
  "deltic.streamProducer/1": brands.STREAM_PRODUCER,
  "deltic.suspending/1": brands.SUSPENDING,
  "deltic.stream/1": brands.STREAM,
  "deltic.future/1": brands.FUTURE,
  "deltic.errorContext/1": brands.ERROR_CONTEXT,
  "deltic.resourceState/1": brands.RESOURCE_STATE,
  "deltic.pollable/1": brands.POLLABLE,
  "deltic.wasiExit/1": brands.WASI_EXIT,
  "deltic.runtimeCopies/1": brands.RUNTIME_COPIES,
};

Deno.test("A9: every brand key is exactly the contract's table entry", () => {
  for (const [key, sym] of Object.entries(EXPECTED)) {
    assertEquals(sym, Symbol.for(key), `brand key drift for ${key}`);
    assertEquals(Symbol.keyFor(sym), key, `${key} is not a registry symbol`);
  }
});

Deno.test("A9: the table is exhaustive — no unpinned exported brand", () => {
  const exported = (Object.values(brands) as unknown[])
    .filter((v): v is symbol => typeof v === "symbol")
    .map((s) => Symbol.keyFor(s) ?? "<not a registry symbol>")
    .sort();
  assertEquals(exported, Object.keys(EXPECTED).sort());
});

Deno.test("A9: the protocol generation matches the key suffix", () => {
  assertEquals(PROTOCOL_GENERATION, 1);
  for (const key of Object.keys(EXPECTED)) {
    assertEquals(key.endsWith(`/${PROTOCOL_GENERATION}`), true, key);
  }
});

Deno.test("A9: brands are non-enumerable and non-writable on prototypes", () => {
  const d = Object.getOwnPropertyDescriptor(
    WitError.prototype,
    brands.WIT_ERROR,
  );
  assertEquals(d?.value, true);
  assertEquals(d?.enumerable, false);
  assertEquals(d?.writable, false);
  // Not inherited by plain objects, and invisible to value walks.
  assertEquals(Object.keys(new WitError(1)).includes("payload"), true);
  assertEquals(
    Object.getOwnPropertySymbols(new WitError(1)).length,
    0,
    "the brand lives on the prototype, never on instances",
  );
});
