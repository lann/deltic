// TEST-ONLY ambient declarations for the JSPI API — the `declare global`
// that used to live in src/jspi/types.ts, evicted from the published
// graph because JSR forbids modifying global types (and the runtime now
// reaches the engine surface through the module-scoped `jspiApi()`).
//
// Tests are never published, and the jspi pin suite drives the engine's
// API directly (`new WebAssembly.Suspending(...)`, `WebAssembly.promising`)
// — for that, the ambient form is the ergonomic one. Shape notes and
// provenance: src/jspi/types.ts.

declare global {
  namespace WebAssembly {
    class Suspending {
      // deno-lint-ignore no-explicit-any
      constructor(fn: (...args: any[]) => any);
    }

    function promising(
      // deno-lint-ignore no-explicit-any
      fn: (...args: any[]) => any,
      // deno-lint-ignore no-explicit-any
    ): (...args: any[]) => Promise<any>;
  }
}

export {};
