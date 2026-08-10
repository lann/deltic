// The jco lane of the boundary microbench (the incumbent baseline; this
// lane retires with the jco era). Needs the npm tree (`npm ci` here) and
// a transpile (`node jco-transpile.mjs transpile ...` — the recipe does
// both):
//
//   node --experimental-wasm-jspi driver-jco.mjs <shape> <mode> <iters> <size> [reps]
//
// Emits the same JSON line shape as driver-deltic.mjs.
import { readFile } from "node:fs/promises";
import { instantiate } from "./generated/bench.js";
import { bindImports } from "@polymorph/component-test-js/imports";
import { cli, clocks, io, random, filesystem } from "@bytecodealliance/preview2-shim";
import { makeHost } from "./host.mjs";

const [shape, mode, itersS, sizeS, repsS] = process.argv.slice(2);
const iters = Number(itersS), size = Number(sizeS), reps = Number(repsS ?? 5);

const modules = new Map();
for (const name of ["bench.core.wasm", "bench.core2.wasm", "bench.core3.wasm"]) {
  modules.set(name, await WebAssembly.compile(await readFile(new URL(`./generated/${name}`, import.meta.url))));
}
const imports = bindImports({
  wasi: { cli, clocks, io, random, filesystem },
  env: [],
  sut: { "bench:boundary/host": makeHost(mode) },
});
const inst = await instantiate((n) => modules.get(n), imports);
const fn = { send: inst.send, recv: inst.recv, "send-sync": inst.sendSync }[shape];

await fn(Math.min(iters, 1000), size); // warmup
const times = [];
for (let r = 0; r < reps; r++) {
  const t0 = performance.now();
  await fn(iters, size);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(JSON.stringify({ lane: "jco-node-jspi", shape, mode, size, iters, medianMs: median, callsPerSec: Math.round(iters / (median / 1000)) }));
