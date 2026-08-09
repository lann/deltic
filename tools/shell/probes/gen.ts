// Regenerates `tools/shell/probes/*.wasm` from the checked-in `.wat` sources
// via `wasm-tools parse` (repo precedent: runtime/tests/embedder/*.wat).
//
// Usage: deno run -A tools/shell/probes/gen.ts
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const dir = dirname(fromFileUrl(import.meta.url));

const wats = [
  "multi-memory",
  "wasm-gc",
  "exception-handling",
  "memory64",
  "tail-calls",
  "relaxed-simd",
  "jspi",
];

for (const name of wats) {
  const wat = join(dir, `${name}.wat`);
  const wasm = join(dir, `${name}.wasm`);
  const cmd = new Deno.Command("wasm-tools", {
    args: ["parse", wat, "-o", wasm],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`wasm-tools parse ${wat} failed`);
  console.log(`generated ${wasm}`);
}
