;; activation.wat — the one hand-written wasm fixture used across all JSPI
;; empirical pinning tests (runtime/tests/jspi/).
;;
;; Deliberately generic: every test instantiates this module (possibly
;; multiple times) with different implementations of the two imports, so the
;; wasm side never needs to change between claims (a)-(g) in the task brief.
;;
;; Imports:
;;   (import "host" "block" (func $block (param i32) (result i32)))
;;     The "may suspend" call site. Tests bind this to a `Suspending`-wrapped
;;     JS function (to observe real suspension), a plain non-Suspending JS
;;     function (fast-path / no-suspension controls), or a function that
;;     traps (post-resume trap test).
;;   (import "host" "glue" (func $glue (param i32) (result i32)))
;;     A second import used only by the frame-rule test: bound to a plain JS
;;     function that itself calls back into a *second instance* of this same
;;     module's "run" export (which internally calls $block) — inserting a
;;     JS frame between the promising entry and the eventual Suspending call.
;;
;; Exports:
;;   (func (export "run") (param i32) (result i32))
;;     Calls $block(x), returns result + 1. The "+1" makes it observable that
;;     control actually returned into wasm after suspension (not just that
;;     the import's return value passed through untouched).
;;   (func (export "run_via_glue") (param i32) (result i32))
;;     Calls $glue(x), returns result + 100. Used by the frame-rule test:
;;     the JS glue function itself performs the nested wasm call that reaches
;;     $block.
;;   (func (export "other") (param i32) (result i32))
;;     A plain export with no imports called — used by the reentry test to
;;     observe whether the same instance can be entered again while another
;;     export's activation is suspended.
;;   (func (export "run_trap") (param i32) (result i32))
;;     Calls $block(x) (a suspension point) then `unreachable` — used by the
;;     post-resume trap test to observe what a `promising`-wrapped Promise
;;     rejects with when the wasm activation traps *after* being resumed.
(module
  (import "host" "block" (func $block (param i32) (result i32)))
  (import "host" "glue" (func $glue (param i32) (result i32)))

  (func (export "run") (param $x i32) (result i32)
    local.get $x
    call $block
    i32.const 1
    i32.add)

  (func (export "run_via_glue") (param $x i32) (result i32)
    local.get $x
    call $glue
    i32.const 100
    i32.add)

  (func (export "other") (param $x i32) (result i32)
    local.get $x
    i32.const 1000
    i32.add)

  (func (export "run_trap") (param $x i32) (result i32)
    local.get $x
    call $block
    drop
    unreachable))
