// The reentrance gate on the sync fused-adapter bracket (issue #99).
//
// Reference chain, component-model @ 73b7ad5
// `design/mvp/canonical-abi/definitions.py`:
//   * `canon_lower` line 2312 invokes the callee `FuncInst` with
//     `caller = thread.task.inst`;
//   * that `FuncInst` is `Store.lift`'s `func_inst`, lines 578-585, whose
//     first statement is `trap_if(not inst.may_enter_from(caller))` (581);
//   * `may_enter_from` (214) tests every instance in
//     `entering_set(caller) = callee.self_and_ancestors()
//                             - caller.self_and_ancestors()` (230-234).
//
// So a *sibling* callee that is currently entered traps, an idle sibling does
// not, and same-instance / ancestor pairs have an empty entering set and never
// trap here (FACT traps those statically instead --
// wasmtime-environ 47.0.3 `fact/trampoline.rs:120-127`).
//
// These tests drive the `enter-sync-call` trampoline directly, because the
// trapping shape is not constructible as a component: mutual sibling imports
// are rejected by validation (instance imports form a DAG). See the
// adjudication note on the trampoline itself.

import { assertEq } from "./support/asserts.ts";
import {
  createTrampoline,
  type SyncCallScope,
  type TrampolineContext,
} from "../src/intrinsics/mod.ts";
import { newStats } from "../src/exec/boundary.ts";
import { ComponentInstanceState, Store } from "../src/task/mod.ts";

function fixture() {
  const store = new Store();
  const insts = new Map<number, ComponentInstanceState>();
  const syncCallStack: SyncCallScope[] = [];
  const ctx = {
    componentInstance: (i: number) => {
      let s = insts.get(i);
      if (s === undefined) {
        s = new ComponentInstanceState(i, store);
        insts.set(i, s);
      }
      return s;
    },
    syncCallStack,
    factStartScopes: [],
    stats: newStats(),
    trapState: { pending: undefined },
  } as unknown as TrampolineContext;
  const enter = createTrampoline({ kind: "enter-sync-call", index: 0 } as never, ctx);
  const exit = createTrampoline({ kind: "exit-sync-call", index: 0 } as never, ctx);
  const inst = (i: number) => (ctx as TrampolineContext).componentInstance(i);
  return { ctx, enter, exit, inst, syncCallStack };
}

/** `A` = instance 0, `C` = instance 1; sync (`async_ = 0`) throughout. */
const A = 0;
const C = 1;

Deno.test("enter-sync-call: idle sibling callee is enterable", () => {
  const { enter, exit, inst, syncCallStack } = fixture();
  inst(A).mayEnter = false; // the host entered A (boundary `enterFrom(null)`)
  enter(A, 0, C);
  assertEq(syncCallStack.length, 1, "bracket opened");
  exit();
  assertEq(syncCallStack.length, 0, "bracket closed");
});

Deno.test("enter-sync-call: sibling cycle A -> C -> A traps", () => {
  const { enter, inst } = fixture();
  // Host entered A; A is mid-call into C, so C is entered too. The cycle is
  // C calling back into A.
  inst(A).mayEnter = false;
  inst(C).mayEnter = false;
  let msg = "";
  try {
    enter(C, 0, A);
  } catch (e) {
    msg = String((e as Error).message ?? e);
  }
  assertEq(
    msg.includes("cannot enter component instance"),
    true,
    `expected the reentrance trap, got: ${msg || "<no trap>"}`,
  );
  // polyengine#145: a TRANSIENT reentrance refusal (live-call overlap, nothing
  // poisoned) must stay byte-identical — the poison-cause suffix is what
  // distinguishes the corpse from the crowd.
  assertEq(
    msg.includes("instance poisoned by"),
    false,
    `transient refusal must not claim poisoning: ${msg}`,
  );
});

Deno.test("enter-sync-call: an acyclic sibling chain A -> B -> C never traps", () => {
  const { enter, exit, inst } = fixture();
  const B = 2;
  inst(A).mayEnter = false;
  enter(A, 0, B);
  enter(B, 0, C);
  exit();
  exit();
  // Nothing above mutates `mayEnter`; the point is that the gate stays quiet
  // for the shape `test/linking/unit.wast` (the sibling relift chain) uses.
  assertEq(inst(B).mayEnter, true);
  assertEq(inst(C).mayEnter, true);
});

Deno.test("enter-sync-call: same-instance pair has an empty entering set", () => {
  const { enter, inst } = fixture();
  // definitions.py `entering_set`: `{A} - {A}` is empty, so `may_enter_from`
  // is vacuously true even with `may_enter == False`. FACT never emits this
  // pair (trampoline.rs:120-127) but the gate must agree with the reference.
  inst(A).mayEnter = false;
  enter(A, 0, A);
});
