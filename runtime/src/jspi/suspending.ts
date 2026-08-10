// The per-declaration suspendability marker (contracts/embedder-api.md
// §"Functions and async", amendment A1; docs/architecture.md §5).
//
// Returning a Promise from a sync-typed host import blocks the calling wasm
// FRAME — a capability with per-call cost (jspi pin (j): a Suspending
// import's continuation is deferred even on the fast path) and legality
// consequences (pin (c): a Suspending import called outside a promising
// activation traps, so a start function must never reach one). Neither cost
// may be imposed silently on every host import, and the plan cannot know
// which imports intend to park (`planNeedsSuspension` sees declarations,
// not host implementations). The embedder therefore declares intent
// per-function: only imports wrapped in `suspending()` are handed to wasm
// as `WebAssembly.Suspending`, everything else keeps the plain calling
// convention and its zero-cost pin.
//
// Layering: this module is import-free on purpose (jspi/ stays standalone);
// the embedder surface re-exports `suspending` from `@deltic/runtime/embedder`.

/** Brand carried by host functions declared suspendable. Local symbol by
 * repo convention (see embedder/resources.ts `STATE`): bundle and source
 * runtimes are never mixed in one process. */
const SUSPENDING = Symbol("deltic.suspending-import");

interface Suspendable {
  [SUSPENDING]?: true;
}

/**
 * Declare that this sync-typed host import may return a Promise, parking
 * the calling wasm frame until it settles (JSPI engines only — the
 * engine-floor caveat of contracts/embedder-api.md §"Functions and async").
 *
 * The declaration is evidence for jspi auto-detection, forces the importing
 * component's entries onto the promising convention (pin (c)), and adds a
 * continuation hop to EVERY call through this import even when it returns
 * synchronously (pin (j)) — mark only imports that genuinely park. Async-
 * typed imports never need this: a Promise from an async import rides the
 * task core with no JSPI involved.
 *
 * The value is marked in place (functions are objects); the return is the
 * same function, typed for insertion into an imports record.
 */
export function suspending<F extends CallableFunction>(fn: F): F {
  (fn as F & Suspendable)[SUSPENDING] = true;
  return fn;
}

/** Brand check (executor-side). */
export function isSuspending(value: unknown): boolean {
  return typeof value === "function" &&
    (value as Suspendable)[SUSPENDING] === true;
}

/**
 * Does this imports record declare any suspending leaf? Evidence for
 * `chooseMode`: a marked import is an embedder statement that a park is
 * expected, so auto-detection selects jspi even when the plan itself shows
 * no blocking declarations (the p2 sync-world case: a component whose only
 * blocking site is a host pollable). Walks exactly the shapes
 * `lookupHostImport` can reach: top-level values and one level of
 * interface-record members.
 */
export function anySuspendingImport(
  imports: Record<string, unknown> | undefined,
): boolean {
  if (imports === undefined) return false;
  for (const value of Object.values(imports)) {
    if (isSuspending(value)) return true;
    if (value !== null && typeof value === "object") {
      for (const member of Object.values(value)) {
        if (isSuspending(member)) return true;
      }
    }
  }
  return false;
}
