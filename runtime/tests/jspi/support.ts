// Shared instantiation helper for the JSPI empirical pinning tests.

import "../../src/jspi/types.ts";

const wasmPath = new URL("./fixtures/activation.wasm", import.meta.url);
const bytes = await Deno.readFile(wasmPath);
const module = await WebAssembly.compile(bytes);

export interface ActivationExports {
  run: (x: number) => number;
  run_via_glue: (x: number) => number;
  other: (x: number) => number;
  run_trap: (x: number) => number;
}

/** Instantiate a fresh copy of fixtures/activation.wasm with the given
 * `host.block` / `host.glue` import implementations (see activation.wat for
 * the module's shape). Each call produces an independent instance/memory. */
export async function instantiateActivation(
  imports: {
    // deno-lint-ignore no-explicit-any
    block: WebAssembly.Suspending | ((x: number) => any);
    // deno-lint-ignore no-explicit-any
    glue?: (x: number) => any;
  },
): Promise<ActivationExports> {
  const glue = imports.glue ?? ((x: number) => x);
  const instance = await WebAssembly.instantiate(module, {
    host: { block: imports.block, glue },
    // deno-lint-ignore no-explicit-any
  } as any);
  return instance.exports as unknown as ActivationExports;
}
