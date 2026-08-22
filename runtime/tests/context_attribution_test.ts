// Regression pin: an async guest's CALLBACK EPILOGUE `context.set` must land
// in its OWN thread's context slots, even when the epilogue runs in a JSPI
// continuation chunk (empty thread-stack bracket) and a SIBLING task's
// activation claim sits on top of the ambient stack.
//
// THE DEFECT (polyvisor#49 trap 1; the residue of issue #24). wit-bindgen's
// async runtime keeps its per-task state pointer in context slot 0: the
// callback entry reads it and asserts non-null (rt/async_support.rs:577-578),
// nulls the slot for the duration of the invocation (:580), and RESTORES it
// on the way out (:592). When the callback body suspends mid-frame under
// JSPI, that restore runs in a resumed continuation — outside every bracket
// this runtime pushes — and `resolveAmbient` fell through to the TOP of
// `activationClaims`, which by then named the sibling task that suspended
// most recently. Measured in Chromium against this tree's base (3/3 runs):
//
//     T130 get[0] -> 6760688 | stack=[T130,T130] claims=[]      callback entry
//     T130 set[0] = 0        | stack=[T130,T130] claims=[]      body suspends
//     T10  get[0] -> 1146560 | stack=[T10,T10]   claims=[T130]  sibling enters
//     T10  set[0] = 0        | stack=[T10,T10]   claims=[T130]
//     T10  set[0] = 6760688  | stack=[] claims=[T130,T10]   <- T130's restore,
//                                                              attributed to T10
//     T130 get[0] -> 0       | stack=[T130,T130]             -> assert 578 fails
//
// THE FIX (task/scheduler.ts `currentThreadForInstance`): `context.{get,set}`
// are resolved against the COMPONENT INSTANCE that declared the intrinsic
// import — the instance whose core frame is, by construction, the one
// executing — instead of against the unscoped ambient. The two tasks above
// are necessarily of different instances: a callback invocation holds
// `inst.exclusiveThread` for its whole extent, suspensions included
// (exec/boundary.ts `runCallbackLoop`; definitions.py line 2187), so two
// activations of ONE instance can never be mid-frame at the same time.
//
// This test reproduces the ambient state above directly — that is what makes
// it deterministic, where the engine-level interleave is a Chromium-only
// microtask-ordering accident.

import { assertEq } from "./support/asserts.ts";
import { createUnsafeIntrinsic } from "../src/intrinsics/context.ts";
import {
  claimActivationAmbient,
  releaseActivationAmbient,
  withActivation,
} from "../src/task/mod.ts";

/** A thread of `inst`, shaped as `CurrentThreadLike` (storage + task). */
function mkThread(inst: object) {
  return { storage: [0, 0], task: { inst } };
}

Deno.test("callback-epilogue context.set is attributed by declaring instance", () => {
  const instA = { name: "A" };
  const instB = { name: "B" };
  const a = mkThread(instA); // the trapping task (T130 in the trace)
  const b = mkThread(instB); // the sibling that claimed later (T10)

  const setA = createUnsafeIntrinsic("context-set-i32-0", a.task.inst);
  const getA = createUnsafeIntrinsic("context-get-i32-0", a.task.inst);

  // A's callback entry: bracketed, reads and nulls its slot.
  withActivation(a, () => {
    (setA as (v: number) => void)(0x1234);
    assertEq((getA as () => number)(), 0x1234);
    (setA as (v: number) => void)(0);
  });

  // A's body suspends mid-frame holding a stale claim; the sibling B then
  // runs and suspends too, so ITS claim is the newest.
  claimActivationAmbient(a);
  claimActivationAmbient(b);

  // A's epilogue chunk: no bracket (`stack=[]`), claims=[A,B].
  (setA as (v: number) => void)(0x1234);

  assertEq(a.storage[0], 0x1234, "A's restore must land in A's slots");
  assertEq(b.storage[0], 0, "A's restore must NOT land in the sibling's slots");

  // And A's next callback entry finds its state where it left it — the read
  // whose `assert!(!state.is_null())` the guest was tripping.
  assertEq(withActivation(a, () => (getA as () => number)()), 0x1234);

  releaseActivationAmbient(b);
  releaseActivationAmbient(a);
});

Deno.test("instance-scoped context.* falls back when the instance has no candidate", () => {
  const instA = { name: "A" };
  const a = mkThread(instA);
  const other = mkThread({ name: "other" });

  // Declared by an instance with no activation of its own anywhere in the
  // ambient: the unscoped ladder still answers, so nothing that worked before
  // this narrowing stops working (a built-in reached under a foreign bracket
  // keeps the pre-existing answer rather than failing).
  const setA = createUnsafeIntrinsic("context-set-i32-1", instA) as (
    v: number,
  ) => void;
  withActivation(other, () => setA(7));
  assertEq(other.storage[1], 7, "fallback must keep the unscoped answer");

  // A FACT adapter module (plan `instance: null`) is unscoped by construction.
  const setAdapter = createUnsafeIntrinsic("context-set-i32-1", null) as (
    v: number,
  ) => void;
  withActivation(a, () => setAdapter(9));
  assertEq(a.storage[1], 9);
});
