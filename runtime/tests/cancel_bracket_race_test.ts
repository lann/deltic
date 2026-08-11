// #92 (test half): a seeded-shuffle regression pinning the "cancel-bracket
// timing" window named in issue #92.
//
// `Task.requestCancellation` (task/mod.ts:369-428) brackets its delivery with
// `inst.enterFrom(caller)` / `inst.leaveTo(caller)` around
// `SuspensionPoint.resume()` — but under jspi, `resume()` only *settles* the
// suspended activation's Promise; the resumed wasm frame's own continuation
// (its remaining built-ins, `exit-sync-call`, etc.) runs on a LATER
// microtask, after `leaveTo` has already released the bracket. A concurrent
// host EXPORT call that enters the same instance in between goes through
// `exec/boundary.ts`'s `createLiftedFunction` (:1002-1011 in the review's
// line numbers), which gates only on `inst.mayEnterFrom(null)` — it does not
// consult the scheduler's `resumingThread` slot the way `Store.tick`
// (scheduler.ts:876) does.
//
// This test does not *construct* a divergence (issue #92 says none was
// found): it pins that (a) the window is real — `mayEnterFrom` reports the
// instance free immediately after `requestCancellation` returns, even though
// the cancelled activation's continuation has not run yet — and (b) driving
// a second export call through that window today does not double-resume
// anything or leave inconsistent final state, i.e. the corpus-soundness
// claim in the issue. It is included in `just sched-seeds` so any future
// schedule-order dependence here is caught.

import { assertEq } from "./support/asserts.ts";
import { createWaitableSetWait } from "../src/intrinsics/async_builtins.ts";
import { createLiftedFunction, newStats, type ResolvedOptions } from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const ASYNC_FT: FuncType = { params: [], results: [], async: true };
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

Deno.test(
  "#92: requestCancellation's enter/leave bracket releases before the " +
    "resumed jspi activation's continuation runs — a concurrent export " +
    "call can enter in between without an observed double-resume",
  async () => {
    const store = new Store();
    const inst = new ComponentInstanceState(0, store);
    const wset = new WaitableSet();
    const seti = inst.handles.add(wset);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = {
      addrType: "i32" as const,
      get bytes() {
        return new Uint8Array(memory.buffer);
      },
      get view() {
        return new DataView(memory.buffer);
      },
      get length() {
        return memory.buffer.byteLength;
      },
      ptrType: () => "i32" as const,
      ptrSize: () => 4 as const,
    };
    const opts: ResolvedOptions = {
      stringEncoding: "utf8",
      // deno-lint-ignore no-explicit-any
      memory: view as any,
      realloc: null,
      postReturn: null,
      callback: null,
      async: true,
      cancellable: true, // the caller's `cancellable` canonical option.
      coreType: { params: ["i32", "i32"], results: ["i32"] },
      instance: inst,
    };
    const ctx = {
      componentInstance: () => inst,
      options: () => opts,
      resultTypes: () => [],
    };
    const task = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
    task.state = "started";
    const thread = new Thread(task, (function* () {})());

    // Park task A at a cancellable `waitable-set.wait` (jspi mode) — no
    // event pending, so this is SITE 2's genuine suspension.
    const wait = createWaitableSetWait({ options: 0 }, ctx, inst, "jspi");
    pushCurrentThread(thread);
    let parked: unknown;
    try {
      parked = wait(seti, 0);
    } finally {
      popCurrentThread(thread);
    }
    assertEq(typeof parked, "object"); // a Promise, per blockCurrentActivation.
    assertEq(store.waiting.length, 1);

    // Sanity: the instance is correctly gated WHILE parked.
    assertEq(inst.mayEnterFrom(null), true); // parked tasks release the gate (#43).

    // Deliver the cancellation exactly as `Task.requestCancellation` does:
    // finds the parked SuspensionPoint as a candidate (it is registered with
    // `task === task` and `cancellable === true`), brackets `enter/leave`
    // around its (synchronous) `resume`.
    task.requestCancellation(null);

    // THE WINDOW: `requestCancellation` has already called `leaveTo`, so the
    // instance looks fully free — even though the resumed activation's own
    // continuation (the `.then()` the engine attached to the settled
    // Promise) has not run yet. This is exactly the gap #92 names.
    assertEq(inst.mayEnterFrom(null), true);
    assertEq(task.state, "cancel-delivered");

    // Drive a concurrent EXPORT call into the SAME instance through the
    // real host-entry path (`createLiftedFunction`), which gates only on
    // `mayEnterFrom` — not on the scheduler's `resumingThread` claim that
    // `Store.tick` respects (scheduler.ts:876). If this traps or corrupts
    // state, the divergence is no longer merely theoretical.
    const syncFt: FuncType = { params: [], results: [], async: false };
    const exportOpts: ResolvedOptions = {
      stringEncoding: "utf8",
      memory: null,
      realloc: null,
      postReturn: null,
      callback: null,
      async: false,
      cancellable: false,
      coreType: { params: [], results: [] },
      instance: inst,
    };
    const lifted = createLiftedFunction({
      name: "concurrent-export",
      ft: syncFt,
      opts: exportOpts,
      core: () => undefined,
      stats: newStats(),
    });
    let raised: unknown;
    try {
      lifted();
    } catch (e) {
      raised = e;
    }
    // Pin the CURRENT observed behaviour: the concurrent entry is admitted
    // (no "reentrance forbidden" trap), matching the issue's finding that
    // `mayEnterFrom` does not consult `resumingThread`.
    assertEq(raised, undefined);

    // Let the cancelled activation's own continuation actually run (the
    // microtask the engine scheduled when `resume()` settled its Promise),
    // and confirm no double-resume assertion fired and the final state is
    // consistent: the SuspensionPoint is done, the WaitableSet was never
    // touched by the concurrent export (it did not join or wait), and no
    // exception escaped this far.
    let sawRejection: unknown;
    await (parked as Promise<unknown>).catch((e) => {
      sawRejection = e;
    });
    // A cancelled `waitable-set.wait` resolves with TASK_CANCELLED — not a
    // rejection — so nothing should have been caught here.
    assertEq(sawRejection, undefined);
    assertEq(store.waiting.length, 0);
  },
);
