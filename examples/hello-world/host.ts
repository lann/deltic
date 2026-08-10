// The host half of the hello-world example.
//
// Pipeline, in full:
//   1. translate — the translator shim (a wasm module itself) turns the
//      component binary into an execution plan + FACT adapter modules;
//   2. instantiate — the embedder API links host imports (none here) and
//      returns typed-shaped exports;
//   3. call — exports are uniformly Promise-shaped (a sync guest resolves
//      immediately); values cross per contracts/embedder-api.md.
//
// Run with: ./run.sh   (or: deno run --allow-read host.ts, after building
// the guest and the translator shim — run.sh does both).
//
// Inside this repository `@deltic/runtime` resolves through the Deno
// workspace; a published consumer uses the same specifier via JSR/npm or
// the `deltic-embedder.mjs` release bundle (deltic#16 tracks packaging).

import { Translator } from "@deltic/runtime/shim";
import { instantiate } from "@deltic/runtime/embedder";

// --- 1. translate ----------------------------------------------------------

const shimWasm = await Deno.readFile(
  new URL(
    "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
    import.meta.url,
  ),
);
const translator = await Translator.create(shimWasm);

const componentBytes = await Deno.readFile(
  new URL("build/hello.component.wasm", import.meta.url),
);
const { plan, adapters } = translator.translate(componentBytes);

// --- 2. instantiate --------------------------------------------------------

// The second argument is the imports record. This world imports nothing,
// so it is empty — see ../kitchen-sink for the full shape.
const component = await instantiate({ plan, componentBytes, adapters }, {});

// --- 3. call ---------------------------------------------------------------

const greeting = await component.exports.greet("component model");
console.log(greeting);

if (greeting !== "Hello, component model!") {
  throw new Error(`unexpected greeting: ${greeting}`);
}
console.log("hello-world example: OK");
