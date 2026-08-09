// ct-runner: deltic's L3 execution runner for polymorph-test's L1
// suite contract (TRACK C2-D; docs/consumers.md, C2).
//
// "Execute an L1 suite component, emit canonical results JSONL (L4)" — an
// introspecting host runner (ARCHITECTURE.md Rule 3): it drives
// `polymorph:test/tests@0.1.0` directly against a host-side `test-context`
// provider, never composing wasm for L2. See src/run-suite.ts for the case
// loop and src/context.ts for the host resource.

export {
  type RunCounts,
  runSuite,
  type RunSuiteOptions,
  TESTS_INTERFACE,
} from "./run-suite.ts";

export {
  analyzeImports,
  type ImportAnalysis,
  MissingImportsError,
  requireImportsResolved,
} from "./import-analysis.ts";

export { Context, TEST_CONTEXT_INTERFACE, testContextImportRecord } from "./context.ts";
