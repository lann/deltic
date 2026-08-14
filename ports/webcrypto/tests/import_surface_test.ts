// Gate: BOTH of polymorph-webcrypto's conformance suites must be fully
// linkable by this port — translate-only, no instantiation.
//
// `analyzeImports` reports the top-level import keys a suite needs that a
// given imports record does not resolve (ct-runner/src/import-analysis.ts,
// the same version-canonical resolution `instantiate` uses). A non-empty
// `missing` list is exactly the failure this port exists to close, so it
// is asserted to be empty for the shared suite AND the signing suite —
// including `sha1-checked`, which is PROVIDED as a fail-closed interface
// (see src/sha1Checked.ts) rather than left unlinked.
//
// Skipped when the artifacts are absent (the consumer tree or the
// translator shim), like the vector-backed KATs in this directory.

import { Translator } from "../../../runtime/src/shim/mod.ts";
import { analyzeImports } from "../../../ct-runner/src/mod.ts";
import { wasi } from "../../../wasi/src/mod.ts";
import { webcryptoImports } from "../src/mod.ts";
import { assertEq } from "./asserts.ts";

const CE_ROOT = new URL("../../../", import.meta.url).pathname;
const SHIM = `${CE_ROOT}target/wasm32-unknown-unknown/release/translator_shim.wasm`;
const SUITES = "/home/lmartin/p/polymorph/polymorph-webcrypto/target/wasm32-wasip2/release";

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(path);
  } catch {
    return undefined;
  }
}

async function missingLeaves(suite: string): Promise<string[] | undefined> {
  const shim = await readIfPresent(SHIM);
  const componentBytes = await readIfPresent(`${SUITES}/${suite}.wasm`);
  if (shim === undefined || componentBytes === undefined) return undefined;
  const translator = await Translator.create(shim);
  const { plan } = translator.translate(componentBytes);
  const analysis = analyzeImports(plan, { ...wasi(), ...webcryptoImports() });
  return analysis.missing;
}

for (const suite of ["conformance_guest_ct", "conformance_signing_guest_ct"]) {
  Deno.test(`import surface: ${suite} has zero unresolved leaves under wasi() + webcryptoImports()`, async () => {
    const missing = await missingLeaves(suite);
    if (missing === undefined) {
      console.log("  (skip: the suite artifact or the translator shim is not built)");
      return;
    }
    assertEq(missing.join(", "), "");
  });
}
