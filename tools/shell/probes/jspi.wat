;; Capability probe: JSPI (stack-switching) round trip.
;; Imports "" "f" (a JS Suspending function) and re-exports a call to it, so
;; the driver can wrap it with WebAssembly.promising and await the result —
;; mirrors harness/browser/entry.ts's probeJspi hand-assembled module.
;; Regenerate: wasm-tools parse jspi.wat -o jspi.wasm
(module
  (import "" "f" (func $f (result i32)))
  (func (export "g") (result i32) (call $f)))
