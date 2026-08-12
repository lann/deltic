;; Host-import err PAYLOAD fixture (contracts/embedder-api.md §"Error model").
;;
;; The sibling `host-result.wat` pins the *branding* with `result` (both sides
;; empty), whose flat lowering is a single i32 and needs no memory. This one
;; pins the **payload lowering** — `ComponentException.payload` -> the guest's err case —
;; with `result<u32, string>`: three flat values, so the lowered import spills
;; through a return pointer, and the string rides the guest's realloc.
;;
;; Memory layout of `result<u32, string>` at the retptr (definitions.py
;; `store_variant`): a 1-byte discriminant, then the payload at offset 4
;; (max case alignment = 4). So
;;   +0 : u8   discriminant (0 = ok, 1 = err)
;;   +4 : u32  the ok value, OR the err string's pointer
;;   +8 : u32  the err string's byte length
;;
;; `run` returns `val` on ok and `1000 + byteLength` on err, so one u32 tells
;; the test which case arrived AND that the payload survived the round trip.
;;
;; Regenerate: wasm-tools parse host-result-payload.wat -o host-result-payload.wasm
(component
  (import "host:api/fallible" (instance $api
    (export "try-it" (func (result (result u32 (error string)))))))

  (alias export $api "try-it" (func $try))

  (core module $Mem
    (memory (export "mem") 1)
    (global $next (mut i32) (i32.const 256))
    ;; Bump allocator: enough for one string, which is all this fixture needs.
    (func (export "realloc")
      (param $old i32) (param $oldSize i32) (param $align i32) (param $new i32)
      (result i32)
      (local $p i32)
      (local.set $p (global.get $next))
      (global.set $next (i32.add (global.get $next) (local.get $new)))
      (local.get $p)))

  (core instance $mem (instantiate $Mem))

  (canon lower (func $try)
    (memory $mem "mem") (realloc (func $mem "realloc"))
    (core func $try'))

  (core module $M
    (import "mem" "mem" (memory 1))
    (import "" "try-it" (func $try (param i32)))
    (func (export "run") (result i32)
      (call $try (i32.const 16))
      (if (result i32) (i32.load8_u (i32.const 16))
        (then (i32.add (i32.const 1000) (i32.load (i32.const 24))))
        (else (i32.load (i32.const 20))))))

  (core instance $i (instantiate $M
    (with "mem" (instance $mem))
    (with "" (instance (export "try-it" (func $try'))))))

  (func (export "run") (result u32)
    (canon lift (core func $i "run"))))
