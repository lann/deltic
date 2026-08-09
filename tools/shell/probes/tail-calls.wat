;; Capability probe: tail-call proposal (return_call).
;; Regenerate: wasm-tools parse tail-calls.wat -o tail-calls.wasm
(module
  (func $g (result i32) i32.const 1)
  (func (export "f") (result i32) (return_call $g)))
