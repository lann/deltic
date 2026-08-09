;; Capability probe: multi-memory proposal (two declared memories in one
;; module — rejected by engines that don't implement the proposal).
;; Regenerate: wasm-tools parse multi-memory.wat -o multi-memory.wasm
(module
  (memory $m0 1)
  (memory $m1 1)
  (func (export "f") (result i32) i32.const 0))
