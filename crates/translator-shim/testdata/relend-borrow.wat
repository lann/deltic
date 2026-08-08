;; (g) **Re-lending a borrow**: a three-component chain in which a borrow
;; handle is lent onward by a component that does not implement the resource.
;;
;;   $App  --borrow-->  $Mid  --borrow-->  $Def   (defines R)
;;
;; $Mid does not implement R, so the borrow arrives there as a real handle in
;; $Mid's table; passing it on to $Def lends that *borrow* handle again.
;; definitions.py `lift_borrow` (line 1516) calls `add_lender` unconditionally
;; — there is no "only owning handles may be lent" rule — and the borrow
;; handle's own `num_lends` is what blocks dropping it until the onward call
;; returns.
(component
  ;; --- $Def: defines the resource ---------------------------------------
  (component $Def
    (core module $Indirect
      (table (export "ftbl") 1 funcref)
      (type $FT (func (param i32)))
      (func (export "R-dtor") (param i32)
        (call_indirect (type $FT) (local.get 0) (i32.const 0))))
    (core instance $indirect (instantiate $Indirect))
    (type $R' (resource (rep i32) (dtor (core func $indirect "R-dtor"))))
    (export $R "R" (type $R'))
    (canon resource.new $R' (core func $resource.new))

    (core module $DM
      (import "" "ftbl" (table 1 funcref))
      (import "" "resource.new" (func $new (param i32) (result i32)))
      (global $made (mut i32) (i32.const 0))
      (global $live (mut i32) (i32.const 0))
      (func (export "make") (result i32)
        (global.set $made (i32.add (global.get $made) (i32.const 1)))
        (global.set $live (i32.add (global.get $live) (i32.const 1)))
        (call $new (i32.add (i32.const 0x40) (global.get $made))))
      ;; borrow params arrive as the rep here, since $Def implements R
      (func (export "rep") (param $rep i32) (result i32) (local.get $rep))
      (func (export "live") (result i32) (global.get $live))
      (func $dtor (param $rep i32)
        (if (i32.eqz (global.get $live)) (then unreachable))
        (global.set $live (i32.sub (global.get $live) (i32.const 1))))
      (elem (i32.const 0) $dtor))
    (core instance $dm (instantiate $DM (with "" (instance
      (export "ftbl" (table $indirect "ftbl"))
      (export "resource.new" (func $resource.new))))))

    (func (export "make") (result (own $R))
      (canon lift (core func $dm "make")))
    (func (export "rep") (param "r" (borrow $R)) (result u32)
      (canon lift (core func $dm "rep")))
    (func (export "live") (result u32)
      (canon lift (core func $dm "live"))))

  ;; --- $Mid: holds a borrow handle and lends it onward -------------------
  (component $Mid
    (import "def" (instance $d
      (export "R" (type $R (sub resource)))
      (export "rep" (func (param "r" (borrow $R)) (result u32)))))
    (alias export $d "R" (type $R))
    (alias export $d "rep" (func $rep))
    (canon lower (func $rep) (core func $rep'))
    (canon resource.drop $R (core func $drop))

    (core module $MM
      (import "" "rep" (func $rep (param i32) (result i32)))
      (import "" "drop" (func $drop-borrow (param i32)))
      ;; The re-lend: $Mid's borrow handle is lent on to $Def. The borrow
      ;; handle must be dropped before returning (definitions.py
      ;; `Task.return_`: trap_if(num_borrows > 0)); dropping it only succeeds
      ;; because the onward lend was released when `rep` returned.
      (func (export "relend") (param $b i32) (result i32)
        (local $v i32)
        (local.set $v (call $rep (local.get $b)))
        (call $drop-borrow (local.get $b))
        (local.get $v))
      ;; Same, but also takes ownership of a second handle: used to check that
      ;; the own transfer traps when the *same* handle is already lent.
      ;; Lends a handle index that was never allocated. The trap is raised by
      ;; the *inner* ($Mid -> $Def) adapter, so its message has to survive the
      ;; outer ($App -> $Mid) adapter's exception barrier as well: two hops.
      (func (export "relend-bogus") (param $b i32) (result i32)
        (local $v i32)
        (local.set $v (call $rep (i32.const 9999)))
        (call $drop-borrow (local.get $b))
        (local.get $v))
      (func (export "relend-and-take") (param $b i32) (param $o i32) (result i32)
        (local $v i32)
        (local.set $v (call $rep (local.get $b)))
        (call $drop-borrow (local.get $b))
        (call $drop-borrow (local.get $o))
        (local.get $v)))
    (core instance $mm (instantiate $MM (with "" (instance
      (export "rep" (func $rep'))
      (export "drop" (func $drop))))))

    (func (export "relend") (param "r" (borrow $R)) (result u32)
      (canon lift (core func $mm "relend")))
    (func (export "relend-bogus") (param "r" (borrow $R)) (result u32)
      (canon lift (core func $mm "relend-bogus")))
    (func (export "relend-and-take")
          (param "r" (borrow $R)) (param "o" (own $R)) (result u32)
      (canon lift (core func $mm "relend-and-take"))))

  ;; --- $App: owns the handle and starts the chain ------------------------
  (component $App
    (import "def" (instance $d
      (export "R" (type $R (sub resource)))
      (export "make" (func (result (own $R))))))
    (alias export $d "R" (type $R))
    (alias export $d "make" (func $make))
    (import "mid" (instance $m
      (export "relend" (func (param "r" (borrow $R)) (result u32)))
      (export "relend-bogus" (func (param "r" (borrow $R)) (result u32)))
      (export "relend-and-take"
        (func (param "r" (borrow $R)) (param "o" (own $R)) (result u32)))))
    (alias export $m "relend" (func $relend))
    (alias export $m "relend-bogus" (func $relendBogus))
    (alias export $m "relend-and-take" (func $relendAndTake))

    (canon lower (func $make) (core func $make'))
    (canon lower (func $relend) (core func $relend'))
    (canon lower (func $relendBogus) (core func $relend-bogus'))
    (canon lower (func $relendAndTake) (core func $relend-and-take'))
    (canon resource.drop $R (core func $drop))

    (core module $AM
      (import "" "make" (func $make (result i32)))
      (import "" "relend" (func $relend (param i32) (result i32)))
      (import "" "relend-bogus" (func $relendBogus (param i32) (result i32)))
      (import "" "relend-and-take" (func $rat (param i32 i32) (result i32)))
      (import "" "drop" (func $drop (param i32)))

      ;; make -> lend through two hops -> drop. The drop proves every lend was
      ;; released when its call returned.
      (func (export "run") (result i32)
        (local $h i32) (local $v i32)
        (local.set $h (call $make))
        (local.set $v (call $relend (local.get $h)))
        (if (i32.ne (local.get $v) (call $relend (local.get $h)))
          (then unreachable))
        (call $drop (local.get $h))
        (local.get $v))

      ;; Trap raised two adapter hops down.
      (func (export "nested-trap") (result i32)
        (local $h i32)
        (local.set $h (call $make))
        (call $relendBogus (local.get $h)))

      ;; The same handle as both borrow and own: the own transfer must trap
      ;; because the borrow transfer already lent it.
      (func (export "lend-trap") (result i32)
        (local $h i32)
        (local.set $h (call $make))
        (call $rat (local.get $h) (local.get $h))))

    (core instance $am (instantiate $AM (with "" (instance
      (export "make" (func $make'))
      (export "relend" (func $relend'))
      (export "relend-bogus" (func $relend-bogus'))
      (export "relend-and-take" (func $relend-and-take'))
      (export "drop" (func $drop))))))

    (func (export "run") (result u32) (canon lift (core func $am "run")))
    (func (export "lend-trap") (result u32)
      (canon lift (core func $am "lend-trap")))
    (func (export "nested-trap") (result u32)
      (canon lift (core func $am "nested-trap"))))

  (instance $def (instantiate $Def))
  (instance $mid (instantiate $Mid (with "def" (instance $def))))
  (instance $app (instantiate $App
    (with "def" (instance $def))
    (with "mid" (instance $mid))))

  (func (export "run") (alias export $app "run"))
  (func (export "lend-trap") (alias export $app "lend-trap"))
  (func (export "nested-trap") (alias export $app "nested-trap"))
  (func (export "live") (alias export $def "live")))
