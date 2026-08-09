// The host-side `test-context` provider (L1 contract's runner-side growth
// surface): a host-implemented resource class per contracts/embedder-api.md
// §"Resources" (host provides a plain class; the runtime owns instance<->rep
// mapping). The `context` resource's `diagnostic` is an `async func` import
// (WIT: wit/tests.wit `test-context.diagnostic: async func(msg: string)`,
// vendored at examples/guests/test-suite/wit/tests.wit) — per
// contracts/embedder-api.md §"Functions and async", an async-func import may
// be a plain `async` JS function.
//
// ARCHITECTURE.md Rule 3 ("introspecting host runner"): this file *is* the L2
// context-provider component, reimplemented host-side rather than composed in
// as wasm — permitted as long as it stays behaviorally equivalent to the
// layered path. It must never grow beyond what `test-context` names.

/** The frozen L1 interface id `test-context` is provided under. */
export const TEST_CONTEXT_INTERFACE = "polymorph:test/test-context@0.1.0";

/**
 * One case's diagnostic sink. Host-side: no reps, no side tables — see
 * contracts/embedder-api.md's host-implemented-resource column.
 *
 * `diagnostic` "may block cooperatively" per the WIT doc comment; this
 * in-process host implementation never blocks (no backpressure to model),
 * so it resolves immediately — still a valid `async func` implementation
 * (contracts/embedder-api.md: "sync implementations remain legal").
 */
export class Context {
  #onDiagnostic: (msg: string) => void;

  constructor(onDiagnostic: (msg: string) => void) {
    this.#onDiagnostic = onDiagnostic;
  }

  // deno-lint-ignore require-await
  async diagnostic(msg: string): Promise<void> {
    this.#onDiagnostic(msg);
  }
}

/**
 * Build the `test-context` import-record entry
 * (`{ [TEST_CONTEXT_INTERFACE]: { Context } }`), per contracts/embedder-api.md
 * §"Module wiring and instantiation" (resource classes sit at the resource's
 * position in the record, PascalCase).
 *
 * The class is registered once per `instantiate` call regardless of how many
 * cases run against that instance; the runner never asks the guest to
 * construct a `context` (the WIT resource has no constructor — the host
 * always initiates the borrow itself when calling `run`).
 */
export function testContextImportRecord(): Record<string, unknown> {
  return { [TEST_CONTEXT_INTERFACE]: { Context } };
}
