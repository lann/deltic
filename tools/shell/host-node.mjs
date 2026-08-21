// Host preamble for the node-pinned / bun-pinned lanes: installs the two
// host capabilities `tools/shell/entry.ts` needs — a binary file reader and
// a `print()`-shaped stdout line writer — then imports the bundled entry.
//
// Why a preamble instead of node: imports inside the entry: the entry is
// bundled with `--platform browser` and also runs on bare jsshells
// (SpiderMonkey/JSC), so it must not reference node builtins; the
// runtime-specific I/O lives here, unbundled, instead. Run via
// `tools/shell/run-lane.ts <node-pinned|bun-pinned>` (which bundles
// `dist/entry.mjs` first), or directly: `node tools/shell/host-node.mjs`.
// Bun runs this same file (it implements node:fs and ESM .mjs).
import * as fs from "node:fs";

// MUST copy out of node's pooled Buffer: fs.readFileSync returns a Buffer
// whose .buffer is the shared allocation pool (byteOffset != 0, pool-sized),
// and entry.ts/runtime code passes bytes.buffer to WebAssembly APIs —
// handing them the pool would validate/compile garbage bytes. The
// `new Uint8Array(buf)` TypedArray-copy constructor yields a fresh
// zero-offset ArrayBuffer. (Bun's readFileSync also returns a Buffer; the
// copy is correct there too.)
globalThis.__polyengineHostRead = (path) => new Uint8Array(fs.readFileSync(path));

// Neither runtime has the shells' global print(); a stdout line via
// console.log is all entry.ts's emit() needs.
globalThis.print = (s) => console.log(s);

// The .mjs copy (see bundle.ts): with no package.json above it, node parses
// a .js file as CommonJS and would reject the bundle's import/export syntax.
await import("./dist/entry.mjs");
