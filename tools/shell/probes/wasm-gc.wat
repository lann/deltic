;; Capability probe: wasm-GC proposal (a struct type + struct.new/struct.get).
;; Regenerate: wasm-tools parse wasm-gc.wat -o wasm-gc.wasm
(module
  (type $s (struct (field i32)))
  (func (export "f") (result i32)
    (struct.get $s 0 (struct.new $s (i32.const 42)))))
