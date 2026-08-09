// D-2 resolution test: leaves at three 0.2.x versions all resolve against
// the one `@0.2` track provider — via the embedder's real `ImportResolver`,
// not string tricks (contracts/embedder-api.md §"Version canonicalization";
// C0 finding D-2). This is the test the mission dispatch names explicitly.

import { assertEq, assertTrue } from "./asserts.ts";
import { ImportResolver } from "@component-engine/runtime/embedder";
import { wasiShims } from "../src/mod.ts";

Deno.test("D-2: the one wasiShims() @0.2 provider serves 0.2.6 / 0.2.9 / 0.2.12", () => {
  const shims = wasiShims();
  const resolver = new ImportResolver(shims);
  for (const v of ["0.2.6", "0.2.9", "0.2.12"]) {
    const hit = resolver.resolve(`wasi:cli/environment@${v}`);
    assertTrue(hit !== undefined, `resolves at ${v}`);
    assertEq(hit!.key, "wasi:cli/environment@0.2");
    assertEq(hit!.value, shims["wasi:cli/environment@0.2"]);
  }
  // Same claim for a second interface family, to rule out a fluke of one key.
  for (const v of ["0.2.6", "0.2.9", "0.2.12"]) {
    const hit = resolver.resolve(`wasi:io/streams@${v}`);
    assertTrue(hit !== undefined, `io/streams resolves at ${v}`);
    assertEq(hit!.key, "wasi:io/streams@0.2");
  }
});

Deno.test("D-1: the one wasiShims() @0.3 clocks provider serves both diverging drafts", () => {
  const shims = wasiShims();
  const resolver = new ImportResolver(shims);
  const hit = resolver.resolve("wasi:clocks/monotonic-clock@0.3.0");
  assertTrue(hit !== undefined);
  assertEq(hit!.key, "wasi:clocks/monotonic-clock@0.3");
  const provider = hit!.value as Record<string, unknown>;
  assertTrue(typeof provider.waitFor === "function");
  assertTrue(typeof provider.now === "function");
  assertTrue(typeof provider.waitUntil === "function");
});

Deno.test("wasiShims(): captured is reachable and not confused for a WIT import key", () => {
  const shims = wasiShims();
  assertTrue(typeof shims.captured.stdoutText === "function");
  // Registering the fragment must not throw — "captured" has neither `:`
  // nor `/`, so `ImportResolver` never treats it as an unversioned
  // interface-id folding hazard (runtime/src/embedder/version.ts `#register`).
  new ImportResolver(shims);
});
