// The host half of the hello-world example — the whole pipeline is one
// call: give `instantiate` the component bytes and the translator, get
// typed-shaped exports back.
//
// The two wasm files are read with `Deno.readFile`, so this script runs
// with a scoped read permission (run.sh passes it):
//
//   deno run --allow-read=..,../../target host.ts
//
// (Deno's `import ... with { type: "bytes" }` will make this flag-free
// once it stabilizes — it is behind --unstable-raw-imports as of Deno
// 2.9, and `type: "text"` is not an option for binaries: lossy UTF-8
// decoding corrupts them.)
//
// Inside this repository `@deltic/runtime` resolves through the Deno
// workspace; a published consumer uses the same specifier via JSR/npm or
// the `deltic-embedder.mjs` release bundle (deltic#16 tracks packaging).

import { instantiate } from "@deltic/runtime/embedder";

const translator = await Deno.readFile(
  new URL(
    "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
    import.meta.url,
  ),
);
const componentBytes = await Deno.readFile(
  new URL("build/hello.component.wasm", import.meta.url),
);

const component = await instantiate({ componentBytes, translator }, {
  // ... imports would go here; this world has none. See ../kitchen-sink.
});

// Exports are uniformly Promise-shaped (a sync guest resolves immediately).
const greeting = await component.exports.greet("component model");
console.log(greeting);

if (greeting !== "Hello, component model!") {
  throw new Error(`unexpected greeting: ${greeting}`);
}
console.log("hello-world example: OK");
