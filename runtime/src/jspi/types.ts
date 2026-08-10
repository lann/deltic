// Module-scoped types + accessor for the JS Promise Integration (JSPI) API.
//
// JSPI is phase 4 (docs/architecture.md §3) and not yet part of TypeScript's/Deno's
// built-in `lib.dom`/`lib.deno` typings. These declarations match the shape
// implemented by V8 (observed via Deno 2.9.5 / V8 15.0.245.2-rusty) and
// described by the js-promise-integration proposal Overview
// (https://github.com/WebAssembly/js-promise-integration).
//
// Deliberately NOT a `declare global` augmentation (it was one until JSR's
// server-side validation refused the package: "modifying global types is
// not allowed"). The registry policy and the truth agree here: JSPI is an
// OPTIONAL engine capability this runtime probes at runtime, and a global
// augmentation asserted it unconditionally for every downstream consumer.
// The module-scoped view keeps the assertion where the evidence is —
// `jspiApi()` returns the surface only when the engine actually has it.
// (Tests keep their own ambient declarations in
// runtime/tests/jspi/global_types.ts; test files are never published.)

/**
 * The engine's JSPI surface, as probed.
 *
 * `Suspending` wraps a JS function that returns a Promise (or any value —
 * the fast path pinned in `suspending_import_test.ts`) so it can be called
 * as a wasm import that may suspend the calling wasm activation. It must
 * only actually suspend while every frame between the nearest enclosing
 * `promising`-wrapped entry and the call is a wasm frame — the "frame
 * rule" (docs/architecture.md §5; `frame_rule_test.ts` pins the observed
 * error shape).
 *
 * `promising` wraps a wasm-exported function so that calling it returns a
 * Promise instead of (potentially) suspending the JS caller: the wasm
 * activation becomes suspendable, and any `Suspending` import it calls
 * transfers control back to the event loop instead of trapping.
 */
export interface JspiApi {
  // deno-lint-ignore no-explicit-any
  Suspending: new (fn: (...args: any[]) => any) => object;
  promising: (
    // deno-lint-ignore no-explicit-any
    fn: (...args: any[]) => any,
    // deno-lint-ignore no-explicit-any
  ) => (...args: any[]) => Promise<any>;
}

/**
 * The engine's JSPI API, or `null` where the proposal is not implemented.
 * The one sanctioned way to reach `WebAssembly.Suspending`/`promising`
 * from this codebase's published modules.
 */
export function jspiApi(): JspiApi | null {
  const wa = WebAssembly as unknown as Partial<JspiApi>;
  return typeof wa.promising === "function" &&
      typeof wa.Suspending === "function"
    ? (wa as JspiApi)
    : null;
}
