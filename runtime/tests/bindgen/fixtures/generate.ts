// Regenerate the checked-in shim envelopes used by the digest tests.
//
// These are cached translator output for the three wit-bindgen example
// guests: checked in so `deno task test` needs no Rust toolchain, but derived
// artifacts all the same — regenerate them whenever the plan format changes
// (contracts/plan-format.md `formatVersion`).
//
//   cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   ./examples/build.sh
//   deno run --allow-read=.. --allow-write=. \
//     runtime/tests/bindgen/fixtures/generate.ts
//
// The `worldDigest` values the digest tests assert must NOT change when the
// plan format does: the digest is computed from the component's types,
// imports and exports (contracts/digest.md), not from the wire envelope. A
// digest that moves after a regeneration is a bug, not a fixture update.

import { Translator } from "../../../src/shim/mod.ts";

const root = new URL("../../../../", import.meta.url);
const here = new URL(".", import.meta.url);

const shim = await Deno.readFile(
  new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
);
const translator = await Translator.create(shim);

for (const name of ["hello", "values", "resources"]) {
  const component = await Deno.readFile(
    new URL(`examples/guests/build/${name}.component.wasm`, root),
  );
  const { envelopeJson } = translator.translate(component);
  const path = new URL(`${name}.envelope.json`, here);
  await Deno.writeTextFile(path, envelopeJson);
  console.log(`wrote ${name}.envelope.json (${envelopeJson.length} bytes)`);
}
