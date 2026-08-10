// Build-time translation CLI (issue #16, delivery design note item 2).
//
// Translates a component ONCE, at build/deploy time, so production never
// ships the ~0.5 MB (gzip) translator wasm — the deploy set becomes:
//
//   component.wasm            (unchanged)
//   component.plan.json       (this tool's output: the translation envelope
//                              — plan + FACT adapter modules, base64)
//   your host code + @deltic/runtime
//
// and the host reconstitutes artifacts with `artifactsFromEnvelope` (see
// README.md). The envelope embeds the component's sha-256; `instantiate`
// verifies the pair, so a mismatched deploy fails loudly, not subtly.
//
// Usage:
//   deno run --allow-read --allow-write tools/translate/main.ts \
//     <component.wasm> [-o <out.plan.json>] [--shim <translator_shim.wasm>]
//
// Defaults: -o <component>.plan.json next to the input; --shim resolves to
// the repo's built translator (consumers of the published package will get
// a default translator from @deltic/translator once #16 packaging lands).

import { Translator } from "@deltic/runtime/shim";

function usage(): never {
  console.error(
    "usage: translate <component.wasm> [-o <out.plan.json>] [--shim <translator_shim.wasm>]",
  );
  Deno.exit(2);
}

let input: string | undefined;
let output: string | undefined;
let shimPath = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
).pathname;

const args = [...Deno.args];
while (args.length) {
  const a = args.shift()!;
  if (a === "-o") output = args.shift() ?? usage();
  else if (a === "--shim") shimPath = args.shift() ?? usage();
  else if (a.startsWith("-")) usage();
  else if (input === undefined) input = a;
  else usage();
}
if (input === undefined) usage();
output ??= input.replace(/\.wasm$/, "") + ".plan.json";

const componentBytes = await Deno.readFile(input);
const translator = await Translator.create(await Deno.readFile(shimPath));

const t0 = performance.now();
// `translateRaw` IS the artifact: the envelope JSON carries the plan and
// the FACT adapters (base64) in one deterministic file — the same format
// the runtime's artifact cache stores (runtime/src/cache).
const envelope = translator.translateRaw(componentBytes);
const ms = (performance.now() - t0).toFixed(1);

// Fail here, not at deploy time, if the translator rejected the component.
const { loadEnvelope } = await import("@deltic/runtime/plan");
const { wire, adapters } = loadEnvelope(envelope);

await Deno.writeTextFile(output, envelope);
console.log(
  `${output}: ${envelope.length} bytes (${adapters.size} adapters, ` +
    `${wire.imports.length} imports) in ${ms}ms`,
);
