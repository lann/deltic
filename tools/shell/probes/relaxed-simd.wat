;; Capability probe: relaxed-simd proposal (i8x16.relaxed_swizzle).
;; Regenerate: wasm-tools parse relaxed-simd.wat -o relaxed-simd.wasm
(module
  (func (export "f") (result v128)
    (i8x16.relaxed_swizzle (v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)
                            (v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0))))
