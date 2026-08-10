// Run the full boundary sweep and print the comparison table. Invoked by
// `just bench-boundary [with-jco]` with the bundle + translator paths;
// lanes: deltic on plain node (callback + jspi) and deno, plus jco under
// node when the npm tree + transpile are present (with-jco).
//
//   node sweep.mjs <bundle.mjs> <translator.wasm> [--with-jco]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [bundle, translator, withJco] = process.argv.slice(2);
const SHAPES = ["send", "recv", "send-sync"];
const MODES = ["immediate", "microtask"];
const SIZES = [0, 1200];
const rows = [];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: new URL(".", import.meta.url).pathname });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`);
  rows.push(JSON.parse(r.stdout.trim().split("\n").at(-1)));
}

const jco = withJco === "--with-jco" && existsSync(new URL("./generated/bench.js", import.meta.url));
for (const shape of SHAPES) {
  for (const mode of MODES) {
    for (const size of SIZES) {
      run("node", ["driver-deltic.mjs", bundle, translator, shape, mode, "50000", String(size), "5"]);
      run("node", ["--experimental-wasm-jspi", "driver-deltic.mjs", bundle, translator, shape, mode, "20000", String(size), "5", "jspi"]);
      run("deno", ["run", "-A", "driver-deltic.mjs", bundle, translator, shape, mode, "50000", String(size), "5"]);
      if (jco) {
        const iters = shape === "send-sync" ? "50000" : "1500";
        run("node", ["--experimental-wasm-jspi", "driver-jco.mjs", shape, mode, iters, String(size), "5"]);
      }
    }
  }
}

const lanes = [...new Set(rows.map((r) => r.lane))];
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("shape", 10) + pad("mode", 11) + pad("size", 6) + lanes.map((l) => String(l).padStart(22)).join(""));
for (const shape of SHAPES) {
  for (const mode of MODES) {
    for (const size of SIZES) {
      const cells = lanes.map((lane) => {
        const r = rows.find((x) => x.lane === lane && x.shape === shape && x.mode === mode && x.size === size);
        return (r ? `${r.callsPerSec.toLocaleString("en-US")}/s` : "-").padStart(22);
      });
      console.log(pad(shape, 10) + pad(mode, 11) + pad(size, 6) + cells.join(""));
    }
  }
}
