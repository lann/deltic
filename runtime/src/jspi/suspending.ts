// The per-declaration suspendability marker (contracts/embedder-api.md
// §"Functions and async", amendments A1/A2; docs/architecture.md §5).
//
// The canonical definitions live in `@deltic/protocol` since amendment A9:
// the mark is a process-global `Symbol.for("deltic.suspending/1")` brand, so
// a function marked by ANY runtime copy is honored by every other copy
// (issue #83 — a module-local symbol made a copy-B mark invisible to copy A's
// `anySuspendingImport`, silently downgrading the calling convention and
// surfacing far away as `NeedsJspi`).
//
// Layering: this module was import-free on purpose (jspi/ stays standalone);
// A9 relaxes that to "imports `@deltic/protocol` only" — the protocol package
// is itself dependency-free, so jspi/ still pulls in no runtime machinery.
// The embedder surface re-exports `suspending` from `@deltic/runtime/embedder`.

export { anySuspendingImport, isSuspending, suspending } from "@deltic/protocol";
