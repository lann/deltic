;; (b) Two inline component instances with a cross-instance call.
;;
;; Component $A exports a lifted function `add`. Component $B imports it,
;; lowers it back into core wasm, and calls it from its own core module. The
;; lift/lower pair crosses a component-instance boundary, so wasmtime's FACT
;; must synthesize a fused adapter module (pure core wasm) to connect them.
(component
  (component $A
    (core module $MA
      (func (export "add") (param i32 i32) (result i32)
        local.get 0
        local.get 1
        i32.add))
    (core instance $ia (instantiate $MA))
    (func (export "add") (param "a" u32) (param "b" u32) (result u32)
      (canon lift (core func $ia "add"))))

  (component $B
    (import "adder" (instance $adder
      (export "add" (func (param "a" u32) (param "b" u32) (result u32)))))
    (core func $add_lowered (canon lower (func $adder "add")))
    (core module $MB
      (import "adder" "add" (func $add (param i32 i32) (result i32)))
      (func (export "add3") (param i32 i32 i32) (result i32)
        (call $add (call $add (local.get 0) (local.get 1)) (local.get 2))))
    (core instance $ib (instantiate $MB
      (with "adder" (instance (export "add" (func $add_lowered))))))
    (func (export "add3") (param "a" u32) (param "b" u32) (param "c" u32) (result u32)
      (canon lift (core func $ib "add3"))))

  (instance $a (instantiate $A))
  (instance $b (instantiate $B (with "adder" (instance $a))))
  (export "add3" (func $b "add3")))
