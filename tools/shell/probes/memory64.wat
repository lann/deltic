;; Capability probe: memory64 proposal (i64-indexed linear memory).
;; Regenerate: wasm-tools parse memory64.wat -o memory64.wasm
(module
  (memory i64 1)
  (func (export "f") (result i32) i32.const 0))
