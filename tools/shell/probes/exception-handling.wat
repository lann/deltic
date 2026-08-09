;; Capability probe: exception-handling proposal (try_table + exnref, the
;; post-"legacy" EH shape used by Component Model error-context work).
;; Regenerate: wasm-tools parse exception-handling.wat -o exception-handling.wasm
(module
  (tag $e (param i32))
  (func (export "f") (result i32)
    (block $ok (result i32)
      (try_table (result i32) (catch $e $ok)
        (throw $e (i32.const 7)))
      (unreachable))))
