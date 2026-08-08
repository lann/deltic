// Ambient type declarations for the JS Promise Integration (JSPI) API.
//
// JSPI is phase 4 (PLAN.md §3) and not yet part of TypeScript's/Deno's
// built-in `lib.dom`/`lib.deno` typings, so `WebAssembly.Suspending` and
// `WebAssembly.promising` are declared here by hand, matching the shape
// implemented by V8 (observed via Deno 2.9.5 / V8 15.0.245.2-rusty) and
// described by the js-promise-integration proposal Overview
// (https://github.com/WebAssembly/js-promise-integration).
//
// Kept in its own file so the rest of the `jspi/` module can import types
// without re-declaring the global augmentation.

declare global {
  namespace WebAssembly {
    /**
     * Wraps a JS function that returns a Promise (or any value — see the
     * fast path pinned in `suspending_import_test.ts`) so it can be called
     * as a wasm import that may suspend the calling wasm activation.
     *
     * Must only be called (i.e. actually suspend) while every frame between
     * the nearest enclosing `WebAssembly.promising`-wrapped entry and this
     * call is a wasm frame — the "frame rule" (PLAN.md §5). A JS frame
     * anywhere in between traps; see `frame_rule_test.ts` for the pinned,
     * observed error shape.
     */
    class Suspending {
      // deno-lint-ignore no-explicit-any
      constructor(fn: (...args: any[]) => any);
    }

    /**
     * Wraps a wasm-exported function so that calling it returns a Promise
     * instead of (potentially) suspending the JS caller: the wasm activation
     * becomes suspendable, and any `Suspending` import it calls transfers
     * control back to the event loop instead of trapping.
     */
    function promising(
      // deno-lint-ignore no-explicit-any
      fn: (...args: any[]) => any,
      // deno-lint-ignore no-explicit-any
    ): (...args: any[]) => Promise<any>;
  }
}

export {};
