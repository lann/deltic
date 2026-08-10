;; fact-callback-suspend.wat — regression fixture for the FACT callback-ABI
;; re-entry `promising` wrap (runtime/src/intrinsics/fact_calls.ts,
;; `mkCalleeTask`'s `body`).
;;
;; THE SHAPE THIS PINS
;;
;; `jspi/bridge.ts`'s invariant names exactly three wasm entries that can reach
;; a blocking built-in and therefore must be `promising`-wrapped in jspi mode:
;; a lifted export's core function, a CALLBACK export, and a FACT adapter
;; callee invoked by `{sync,async}-start-call`. The FACT path wrapped the
;; *initial* callee entry but entered the callee's CALLBACK re-entries
;; unwrapped — so a composed callee that
;;
;;   1. parks on the initial activation (returns the WAIT callback code), and
;;   2. on a later callback activation reaches a *synchronous* blocking
;;      built-in mid-frame (the wit-bindgen `block_on` shape: start a subtask
;;      and `waitable-set.wait` on it without returning WAIT),
;;
;; suspended inside a plain JS frame: `SuspendError: trying to suspend without
;; WebAssembly.promising`.
;;
;; `async/cross-abi-calls.wast` cannot catch this: its callees only ever block
;; by returning WAIT codes, never synchronously mid-activation. It took the
;; first composed consumer workload (the wosh client's fused iroh endpoint,
;; which signs a TLS CertificateVerify via `block_on(webcrypto sign)` inside
;; packet processing) to hit it.
;;
;; LAYOUT
;;
;;   host  --(gate: async host import, resolves on a macrotask)--> $Callee
;;   $Caller.go  --async lower--> $Callee.step   (crosses a component-instance
;;                                                boundary => FACT
;;                                                `async-start-call`, which is
;;                                                the site under test)
;;
;; $Callee.step is async-lifted with the CALLBACK ABI, so the FACT callee task
;; runs `runCallbackLoop` — the loop whose `callback` argument is the thing
;; this fixture forces through a real suspension.
;;
;; $Callee imports `waitable-set.wait`, which is unconditionally
;; block-capable (`trampolineNeedsSuspension`, jspi/bridge.ts), so the whole
;; instantiation is chosen "jspi" and $Callee's core instance lands in
;; `Executor.suspendableFuncs` (i.e. `canBlock` is true at the FACT site).
;;
;; ENCODINGS USED HERE (verified against definitions.py, not memory)
;;
;;   * callback result packing (`unpack_callback_result`, line 2226):
;;     `code = packed & 0xf`, `waitable_set_index = packed >> 4`;
;;     CallbackCode EXIT=0, YIELD=1, WAIT=2 (line 2220).
;;   * async `canon lower` return (line 2305): eager resolution returns the
;;     bare `Subtask.State.RETURNED` (2); otherwise
;;     `subtask.state | (subtaski << 4)` with state STARTING=0, STARTED=1,
;;     RETURNED=2 (line 858).
;;   * EventCode SUBTASK = 1 (line 756); the callback's three params are
;;     `(event_code, p1, p2)` (line 2205), and for a SUBTASK event
;;     p1 = subtask index, p2 = subtask state (line 2299).
;;   * `waitable-set.wait` returns the event code and stores p1 at `ptr`,
;;     p2 at `ptr + 4` (`unpack_event`, line 2429).
(component
  ;; An async host import. The test binds it to a JS function returning a
  ;; promise that settles on a macrotask (setTimeout), so both of $Callee's
  ;; gate subtasks are genuinely pending when it blocks on them.
  (import "gate" (func $gate async))

  ;; -------------------------------------------------------------------------
  ;; $Callee — the FACT callee: async lift, callback ABI.
  ;; -------------------------------------------------------------------------
  (component $Callee
    (import "gate" (func $gate async))

    (core module $Mem (memory (export "mem") 1))
    (core instance $mem (instantiate $Mem))

    (canon task.return (result u32) (core func $task.return))
    (canon waitable-set.new (core func $ws.new))
    (canon waitable.join (core func $w.join))
    (canon waitable-set.wait (memory $mem "mem")
      (core func $ws.wait))
    (canon subtask.drop (core func $subtask.drop))
    ;; No memory option: `gate` has neither params nor results, so the async
    ;; lower's flat signature is `[] -> [i32]` with no return pointer.
    (canon lower (func $gate) async (core func $gate.async))

    (core module $Core
      (import "" "mem" (memory 1))
      (import "" "task.return" (func $task.return (param i32)))
      (import "" "waitable-set.new" (func $ws.new (result i32)))
      (import "" "waitable.join" (func $w.join (param i32 i32)))
      (import "" "waitable-set.wait" (func $ws.wait (param i32 i32) (result i32)))
      (import "" "subtask.drop" (func $subtask.drop (param i32)))
      (import "" "gate" (func $gate (result i32)))

      (global $ws (mut i32) (i32.const 0))
      ;; Counts completed `gate` calls — round-tripped out through
      ;; `task.return` so the test can observe that BOTH legs ran.
      (global $gates (mut i32) (i32.const 0))

      ;; Start a `gate` subtask, trap unless it genuinely parked (STARTED),
      ;; join it to $ws and return its subtask index.
      (func $start-gate (result i32)
        (local $r i32)
        (local.set $r (call $gate))
        ;; STARTED (1) in the low nibble: anything else means the host gate
        ;; resolved eagerly and this fixture is no longer testing suspension.
        (if (i32.ne (i32.and (local.get $r) (i32.const 0xf)) (i32.const 1))
          (then unreachable))
        (local.set $r (i32.shr_u (local.get $r) (i32.const 4)))
        (call $w.join (local.get $r) (global.get $ws))
        (local.get $r))

      ;; Initial activation: park on gate #1 by returning WAIT.
      (func (export "step") (result i32)
        (global.set $ws (call $ws.new))
        (drop (call $start-gate))
        ;; WAIT (2) with the waitable-set index in the high bits.
        (i32.or (i32.shl (global.get $ws) (i32.const 4)) (i32.const 2)))

      ;; Callback re-entry: gate #1 completed. THIS is the activation the
      ;; regression is about — it blocks SYNCHRONOUSLY, mid-frame, instead of
      ;; returning another WAIT code.
      (func (export "step-cb") (param $ec i32) (param $p1 i32) (param $p2 i32)
                               (result i32)
        (local $sub i32) (local $got i32)
        (if (i32.ne (local.get $ec) (i32.const 1 (; SUBTASK ;)))
          (then unreachable))
        (if (i32.ne (local.get $p2) (i32.const 2 (; RETURNED ;)))
          (then unreachable))
        (call $subtask.drop (local.get $p1))
        (global.set $gates (i32.add (global.get $gates) (i32.const 1)))

        ;; ---- the `block_on` shape ----
        (local.set $sub (call $start-gate))
        (local.set $got (call $ws.wait (global.get $ws) (i32.const 0)))
        (if (i32.ne (local.get $got) (i32.const 1 (; SUBTASK ;)))
          (then unreachable))
        (if (i32.ne (i32.load (i32.const 0)) (local.get $sub))
          (then unreachable))
        (if (i32.ne (i32.load (i32.const 4)) (i32.const 2 (; RETURNED ;)))
          (then unreachable))
        (call $subtask.drop (local.get $sub))
        (global.set $gates (i32.add (global.get $gates) (i32.const 1)))

        (call $task.return (global.get $gates))
        (i32.const 0 (; EXIT ;))))

    (core instance $core (instantiate $Core (with "" (instance
      (export "mem" (memory $mem "mem"))
      (export "task.return" (func $task.return))
      (export "waitable-set.new" (func $ws.new))
      (export "waitable.join" (func $w.join))
      (export "waitable-set.wait" (func $ws.wait))
      (export "subtask.drop" (func $subtask.drop))
      (export "gate" (func $gate.async))))))

    (func (export "step") async (result u32)
      (canon lift (core func $core "step")
        async (callback (func $core "step-cb")))))

  ;; -------------------------------------------------------------------------
  ;; $Caller — async-lifted (callback ABI) `go`, async-lowering $Callee.step.
  ;; The async lower of a cross-instance async lift is what routes through
  ;; FACT's `async-start-call` (fact_calls.ts) rather than the host boundary.
  ;; -------------------------------------------------------------------------
  (component $Caller
    (import "inner" (instance $inner
      (export "step" (func async (result u32)))))

    (core module $Mem (memory (export "mem") 1))
    (core instance $mem (instantiate $Mem))

    (canon task.return (result u32) (core func $task.return))
    (canon waitable-set.new (core func $ws.new))
    (canon waitable.join (core func $w.join))
    (canon subtask.drop (core func $subtask.drop))
    ;; `step` has a result, so the async lower takes a trailing return pointer
    ;; and needs a memory (flatten_functype 'lower', max_flat_results = 0).
    (canon lower (func $inner "step") async (memory $mem "mem")
      (core func $step.async))

    (core module $Core
      (import "" "mem" (memory 1))
      (import "" "task.return" (func $task.return (param i32)))
      (import "" "waitable-set.new" (func $ws.new (result i32)))
      (import "" "waitable.join" (func $w.join (param i32 i32)))
      (import "" "subtask.drop" (func $subtask.drop (param i32)))
      (import "" "step" (func $step (param i32) (result i32)))

      (global $ws (mut i32) (i32.const 0))

      (func (export "go") (result i32)
        (local $r i32)
        (global.set $ws (call $ws.new))
        ;; retptr = 16: $Callee's u32 result lands there when the subtask
        ;; returns.
        (local.set $r (call $step (i32.const 16)))
        ;; The callee parks on its host gate, so the subtask must come back
        ;; STARTED with a handle index. (A RETURNED here would mean the callee
        ;; completed eagerly and the callback re-entry under test never ran.)
        (if (i32.ne (i32.and (local.get $r) (i32.const 0xf)) (i32.const 1))
          (then unreachable))
        (local.set $r (i32.shr_u (local.get $r) (i32.const 4)))
        (call $w.join (local.get $r) (global.get $ws))
        (i32.or (i32.shl (global.get $ws) (i32.const 4)) (i32.const 2 (; WAIT ;))))

      (func (export "go-cb") (param $ec i32) (param $p1 i32) (param $p2 i32)
                             (result i32)
        (if (i32.ne (local.get $ec) (i32.const 1 (; SUBTASK ;)))
          (then unreachable))
        (if (i32.ne (local.get $p2) (i32.const 2 (; RETURNED ;)))
          (then unreachable))
        (call $subtask.drop (local.get $p1))
        ;; Hand $Callee's gate counter (expected: 2) back to the host.
        (call $task.return (i32.load (i32.const 16)))
        (i32.const 0 (; EXIT ;))))

    (core instance $core (instantiate $Core (with "" (instance
      (export "mem" (memory $mem "mem"))
      (export "task.return" (func $task.return))
      (export "waitable-set.new" (func $ws.new))
      (export "waitable.join" (func $w.join))
      (export "subtask.drop" (func $subtask.drop))
      (export "step" (func $step.async))))))

    (func (export "go") async (result u32)
      (canon lift (core func $core "go")
        async (callback (func $core "go-cb")))))

  (instance $callee (instantiate $Callee (with "gate" (func $gate))))
  (instance $caller (instantiate $Caller (with "inner" (instance $callee))))
  (export "go" (func $caller "go")))
