// The consumer-facing embedder bundle: one platform-neutral ES module
// carrying the embedder API surface plus the L3 runner glue, for consumers
// that cannot import deltic's TS sources directly — browser pages/workers
// and plain Node (the callback ABI needs no JSPI flag, so stock `node` can
// import this). Built by ./build.ts with `deno bundle --platform browser`
// (the same emission the browser lanes use, tools/browser/bundle.ts) and
// shipped as the `deltic-embedder.mjs` release asset (#16 interim scheme).
//
// Surface discipline: everything here is already public — the embedder API
// (contracts/embedder-api.md), the shim's `Translator`, `@deltic/ct-runner`
// (runSuite + Context + import analysis + the tags inventory), and
// `@deltic/wasi`. The bundle adds no API of its own; per the #8
// rescope there is no runtime code generation anywhere in this graph
// (nothing needs CSP beyond `wasm-unsafe-eval`).

export * from "@deltic/runtime/embedder";
export { Translator } from "@deltic/runtime/shim";
export * from "@deltic/ct-runner";
export { wasi, wasiShims } from "@deltic/wasi";
export type {
  WasiImports,
  WasiOptions,
  // deprecated aliases, kept through the rename transition
  WasiShims,
  WasiShimsOptions,
} from "@deltic/wasi";
