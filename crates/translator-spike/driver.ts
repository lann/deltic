// S0 spike headline demo: wasmtime's component frontend (wasmtime-environ +
// FACT), compiled to wasm32-unknown-unknown, running under a JS engine and
// translating Component Model binaries.
//
// Usage:
//   deno run --allow-read driver.ts [--wasm <path>] [component.wasm ...]
//
// With no component args, runs the four testdata components and asserts the
// spike's go/no-go expectations (trivial: no adapters; linked/async-linked:
// FACT adapters present).

type Summary = {
  component_len: number;
  num_embedded_modules: number;
  num_adapter_modules: number;
  modules: {
    index: number;
    kind: "embedded" | "fact-adapter";
    offset_in_component: number | null;
    len: number;
    imports: string[];
    exports: string[];
  }[];
  initializers: string[];
  trampolines: string[];
  num_runtime_instances: number;
  component_debug: string;
  error?: string;
};

const here = new URL(".", import.meta.url);
const args = [...Deno.args];
let wasmPath = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_spike.wasm",
  import.meta.url,
);
const wasmFlag = args.indexOf("--wasm");
if (wasmFlag !== -1) {
  wasmPath = new URL(args[wasmFlag + 1], here);
  args.splice(wasmFlag, 2);
}

// --- load the translator ---
const t0 = performance.now();
const wasmBytes = await Deno.readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const tLoad = performance.now() - t0;

const exports = instance.exports as {
  memory: WebAssembly.Memory;
  ts_alloc: (len: number) => number;
  ts_dealloc: (ptr: number, len: number) => void;
  ts_translate: (ptr: number, len: number, outLenPtr: number) => number;
};

function translate(component: Uint8Array): Summary {
  const inPtr = exports.ts_alloc(component.length);
  new Uint8Array(exports.memory.buffer, inPtr, component.length).set(component);
  // 4 bytes for the out-length (usize on wasm32).
  const outLenPtr = exports.ts_alloc(4);
  const outPtr = exports.ts_translate(inPtr, component.length, outLenPtr);
  // Re-acquire views: translation may have grown (detached) the memory.
  const outLen = new DataView(exports.memory.buffer).getUint32(outLenPtr, true);
  const json = new TextDecoder().decode(
    new Uint8Array(exports.memory.buffer, outPtr, outLen),
  );
  exports.ts_dealloc(outPtr, outLen);
  exports.ts_dealloc(outLenPtr, 4);
  exports.ts_dealloc(inPtr, component.length);
  return JSON.parse(json);
}

function report(name: string, bytes: Uint8Array): Summary {
  const start = performance.now();
  const s = translate(bytes);
  const ms = performance.now() - start;
  if (s.error) {
    console.error(`${name}: translation FAILED: ${s.error}`);
    Deno.exit(1);
  }
  console.log(`=== ${name} (${bytes.length} bytes, translated in ${ms.toFixed(1)} ms) ===`);
  console.log(
    `  embedded core modules: ${s.num_embedded_modules}, FACT adapters: ${s.num_adapter_modules}, runtime instances: ${s.num_runtime_instances}`,
  );
  for (const m of s.modules) {
    const where = m.kind === "embedded"
      ? `bytes ${m.offset_in_component}..${m.offset_in_component! + m.len}`
      : "FACT-generated";
    console.log(`  module[${m.index}] ${m.kind} (${where}, ${m.len} bytes)`);
    if (m.kind === "fact-adapter") {
      for (const imp of m.imports) console.log(`      import ${imp}`);
      console.log(`      exports: ${m.exports.join(", ")}`);
    }
  }
  console.log(`  plan: ${s.initializers.length} initializers, ${s.trampolines.length} trampolines`);
  for (const i of s.initializers) {
    console.log(`    ${i.length > 120 ? i.slice(0, 117) + "..." : i}`);
  }
  return s;
}

if (args.includes("--bench")) {
  // Steady-state translation timing: translate each testdata component N
  // times inside the same instance.
  const N = 200;
  for (const name of ["trivial", "linked", "async-lift", "async-linked"]) {
    const bytes = await Deno.readFile(new URL(`testdata/${name}.wasm`, here));
    translate(bytes); // warm-up
    const start = performance.now();
    for (let i = 0; i < N; i++) translate(bytes);
    const ms = (performance.now() - start) / N;
    console.log(`${name}: ${ms.toFixed(3)} ms/translation (${bytes.length} bytes, N=${N})`);
  }
  Deno.exit(0);
}

if (args.length > 0) {
  for (const path of args) {
    report(path, await Deno.readFile(path));
  }
} else {
  const testdata = (name: string) =>
    Deno.readFile(new URL(`testdata/${name}.wasm`, here));

  const trivial = report("trivial", await testdata("trivial"));
  if (trivial.num_embedded_modules !== 1 || trivial.num_adapter_modules !== 0) {
    console.error("FAIL: trivial expectations");
    Deno.exit(1);
  }

  const linked = report("linked", await testdata("linked"));
  if (linked.num_embedded_modules !== 2 || linked.num_adapter_modules < 1) {
    console.error("FAIL: linked expectations (need >=1 FACT adapter)");
    Deno.exit(1);
  }

  const asyncLift = report("async-lift", await testdata("async-lift"));
  if (!asyncLift.trampolines.some((t) => t.includes("TaskReturn"))) {
    console.error("FAIL: async-lift should require a TaskReturn trampoline");
    Deno.exit(1);
  }

  const asyncLinked = report("async-linked", await testdata("async-linked"));
  const adapterImports = asyncLinked.modules
    .filter((m) => m.kind === "fact-adapter")
    .flatMap((m) => m.imports);
  if (
    asyncLinked.num_adapter_modules < 1 ||
    !adapterImports.some((i) => i.includes("[prepare-call]"))
  ) {
    console.error("FAIL: async-linked expectations (async FACT adapters)");
    Deno.exit(1);
  }

  console.log(`\nall checks passed (translator load+compile: ${tLoad.toFixed(1)} ms)`);
}
