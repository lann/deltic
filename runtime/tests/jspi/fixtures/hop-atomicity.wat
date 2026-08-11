;; hop-atomicity.wat — regression fixture for HOST-CALL ATOMICITY across the
;; jspi entry hop (runtime/src/exec/boundary.ts, the `leave()` that precedes
;; `drive`/`finishHostEntry`).
;;
;; THE SHAPE THIS PINS
;;
;; In jspi mode a SYNC-lifted export's core entry is `promising`-wrapped, so
;; even when the guest completes synchronously the engine hands back a Promise
;; that settles one microtask later (jspi "pin (j)"). That inserts a HOP
;; between two steps the reference performs atomically:
;;
;;   1. the guest core function returns its i32 result pointer, and
;;   2. the host LIFTS the result out of linear memory through that pointer
;;      (reading the outer (ptr,len) pair, then each inner (ptr,len), then the
;;      bytes).
;;
;; `canon_lift` in definitions.py (line 2213) runs both inside ONE
;; enter/leave bracket: `lower_flat_values`/`lift_flat_values` happen while the
;; callee instance is still entered, so no other host call can observe — let
;; alone mutate — the half-consumed result. Our boundary releases the
;; reentrance bracket at the FIRST park, and a hop-park is a park, so a second
;; host call could enter and run a FULL guest turn in that window. If that turn
;; overwrites the memory the pending lift is about to read, the lift reads
;; whatever the intruder left behind.
;;
;; Observed in the wild as `Trap: list too long` while lifting a
;; `list<list<u8>>` result (the wosh mosh engine's `tick` under real traffic),
;; followed by instance poisoning: a clobbered outer length word of
;; 0xFFFFFFFF exceeds `MAX_LIST_BYTE_LENGTH` (2^28-1,
;; runtime/src/cabi/load.ts:31) by four orders of magnitude.
;;
;; ENCODINGS USED HERE (verified against definitions.py, not memory)
;;
;;   * SYNC-LIFT RESULT POINTER (`flatten_functype`, line 1844-1856): for a
;;     non-async lift, `flat_results = flatten_types(result_type)`, and
;;     `if len(flat_results) > MAX_FLAT_RESULTS` (= 1, line 1842) then
;;     `case 'lift': flat_results = [opts.memory.ptr_type()]`. `list<list<u8>>`
;;     flattens to (i32, i32) — two, so `tick`'s CORE signature is
;;     `(result i32)` and the single i32 it returns is a pointer the CALLEE
;;     chose, not a caller-supplied out-param. (The out-param spelling is the
;;     'lower' case on the very next line: there the retptr is appended to
;;     flat_params instead. Getting these two backwards is the classic error;
;;     this fixture is the 'lift' side.)
;;   * WHAT THE HOST READS AT THAT POINTER (`lift_flat_values`, line 2118):
;;     the over-max branch does `load(cx, ptr, TupleType(ts))` — so for the
;;     single result type `list<list<u8>>` the host loads a 1-tuple, i.e. the
;;     8 bytes at `ptr` are exactly the outer list's (begin, length) pair
;;     (`load_list`, and runtime/src/cabi/load.ts `loadList`). It also traps
;;     on a misaligned or out-of-bounds `ptr` — both satisfied here (0x100 is
;;     4-aligned, one page of memory is reserved).
;;   * LIST REPRESENTATION: a `list<T>` stores (begin: i32, length: i32);
;;     `elem_size(list<u8>)` is 8 and its alignment 4, so the inner element
;;     array is 2 * 8 = 16 bytes of (ptr,len) pairs.
;;
;; No realloc is declared: lifting only READS guest memory. Realloc is the
;; lowering direction (host -> guest), and neither export takes parameters.
;;
;; LAYOUT (all addresses fixed and 4-aligned, page 0 of a 1-page memory)
;;
;;   0x100  outer list (begin=0x200, length=2)      <- `tick` returns 0x100
;;   0x200  inner[0] = (begin=0x300, length=3)
;;   0x208  inner[1] = (begin=0x310, length=2)
;;   0x300  bytes 01 02 03
;;   0x310  bytes 04 05
;;
;; so `tick` lifts as [[1,2,3],[4,5]] — `list<u8>` arrives host-side as a
;; Uint8Array and the outer list as an array (contracts/embedder-api.md;
;; docs/architecture.md §7).
;;
;; `tick` WRITES the whole layout on every call rather than relying on a data
;; segment, so the component self-heals: round 2 of the test can assert the
;; same value and thereby prove the instance stayed healthy after a clobber.
;;
;; `clobber` fills 0x100..0x400 with 0xFF. Against a PENDING un-lifted `tick`
;; result that turns the outer (begin,length) into (0xFFFFFFFF, 0xFFFFFFFF);
;; the length alone makes `loadListFromRange` trap `list too long` before it
;; can even consider the bogus pointer (load.ts:120 precedes the alignment and
;; bounds checks). So the pre-fix failure is a deterministic TRAP, not a
;; garbage value that might accidentally compare equal.
;;
;; THE IMPORT IS NEVER CALLED, but it IS lowered and linked into the core
;; module — the translator's import list is derived from actual LOWERINGS, so
;; an import that is merely declared at the component level is dead-code
;; eliminated and never reaches the embedder facade as a leaf (verified
;; empirically: `requiredImports` returned [] for the declaration-only
;; spelling, and the instantiation stayed in plain mode). Its only job is to
;; give the test somewhere to
;; hand a `suspending()`-marked host function, which is what flips this
;; instantiation into jspi mode: `chooseMode` takes
;; `planNeedsSuspension(plan) || anySuspendingImport(imports)`
;; (exec/executor.ts:385-392), and this plan has no blocking declaration at all
;; — no async lift, no blocking built-in. That mirrors how the wosh engine got
;; flipped (marked wasi imports it never called). Declared as an INTERFACE
;; import so the brand is found through `anySuspendingImport`'s one level of
;; interface-record members (jspi/suspending.ts).
(component
  (import "test:hop/gate" (instance $gate
    (export "wait" (func (result u32)))))
  (alias export $gate "wait" (func $wait))
  ;; Lowered so the translator emits an import leaf; the core module takes it
  ;; and never calls it.
  (canon lower (func $wait) (core func $wait'))

  (core module $Core
    (import "gate" "wait" (func $wait (result i32)))
    (memory (export "mem") 1)

    ;; Write the known layout, then hand back the result pointer. Writing on
    ;; every call is what makes the component self-healing after a clobber.
    (func (export "tick") (result i32)
      ;; outer list -> 2 elements starting at 0x200
      (i32.store (i32.const 0x100) (i32.const 0x200))
      (i32.store (i32.const 0x104) (i32.const 2))
      ;; inner[0] = 3 bytes at 0x300
      (i32.store (i32.const 0x200) (i32.const 0x300))
      (i32.store (i32.const 0x204) (i32.const 3))
      ;; inner[1] = 2 bytes at 0x310
      (i32.store (i32.const 0x208) (i32.const 0x310))
      (i32.store (i32.const 0x20c) (i32.const 2))
      ;; the bytes themselves: 01 02 03 / 04 05
      (i32.store8 (i32.const 0x300) (i32.const 1))
      (i32.store8 (i32.const 0x301) (i32.const 2))
      (i32.store8 (i32.const 0x302) (i32.const 3))
      (i32.store8 (i32.const 0x310) (i32.const 4))
      (i32.store8 (i32.const 0x311) (i32.const 5))
      ;; The sync-lift result POINTER (definitions.py line 1850).
      (i32.const 0x100))

    ;; Overwrite the whole results area — outer pair, inner pairs and byte
    ;; regions alike — with 0xFF.
    (func (export "clobber") (result i32)
      (memory.fill (i32.const 0x100) (i32.const 0xff) (i32.const 0x300))
      (i32.const 1)))

  (core instance $i (instantiate $Core
    (with "gate" (instance (export "wait" (func $wait'))))))

  (func (export "tick") (result (list (list u8)))
    (canon lift (core func $i "tick") (memory $i "mem")))
  (func (export "clobber") (result u32)
    (canon lift (core func $i "clobber"))))
