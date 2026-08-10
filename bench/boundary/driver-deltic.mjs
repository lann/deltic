// The deltic lane of the boundary microbench: runs under BOTH plain
// `node` (callback ABI, no engine flag) and `deno run -A`.
//
//   node driver-deltic.mjs <bundle.mjs> <translator.wasm> <shape> <mode> \
//       <iters> <size> [reps] [jspi]
//
// The bundle is the embedder surface — the LOCAL tree's
// (tools/release-bundle/build.ts output) for tracking this repo, or a
// pinned release asset for cross-version comparison. shape: send | recv
// | send-sync; mode: immediate | microtask (see host.mjs); jspi selects
// jspi-mode suspension (needs --experimental-wasm-jspi under node).
// Emits one JSON line: { lane, shape, mode, size, iters, medianMs,
// callsPerSec }.
import { makeHost } from "./host.mjs";

const isDeno = typeof Deno !== "undefined";
const readFile = isDeno
  ? (p) => Deno.readFile(p)
  : async (p) => new Uint8Array(await (await import("node:fs/promises")).readFile(p));
const argv = isDeno ? Deno.args : process.argv.slice(2);
const [bundlePath, translatorPath, shape, mode, itersS, sizeS, repsS, jspiFlag] = argv;
const iters = Number(itersS), size = Number(sizeS), reps = Number(repsS ?? 5);

const cwd = isDeno ? Deno.cwd() : process.cwd();
const deltic = await import(new URL(bundlePath, `file://${cwd}/`).href);
const translator = await deltic.Translator.create(await readFile(translatorPath));
const componentBytes = await readFile(
  new URL("./guest/target/wasm32-wasip2/release/boundary_bench_guest.wasm", import.meta.url).pathname,
);
const { plan, adapters } = translator.translate(componentBytes);

const imports = {
  ...deltic.wasiShims(),
  "bench:boundary/host@0.1.0": makeHost(mode),
};
const inst = await deltic.instantiate(
  { plan, componentBytes, adapters },
  imports,
  jspiFlag === "jspi" ? { jspi: true } : { jspi: false },
);
const fn = { send: inst.exports.send, recv: inst.exports.recv, "send-sync": inst.exports.sendSync }[shape];

await fn(Math.min(iters, 1000), size); // warmup
const times = [];
for (let r = 0; r < reps; r++) {
  const t0 = performance.now();
  await fn(iters, size);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
const engine = isDeno ? "deno" : "node";
const lane = `deltic-${engine}-${jspiFlag === "jspi" ? "jspi" : "callback"}`;
console.log(JSON.stringify({ lane, shape, mode, size, iters, medianMs: median, callsPerSec: Math.round(iters / (median / 1000)) }));
