// Resume-time ambient-claim discipline (issue #158).
//
// The scheduler's `setResumingThread` asserts that at most one activation
// claims the resumed ambient per turn. `SuspensionPoint.#resumeInner`
// (jspi/bridge.ts) has two arms — `produce` returned a value, or `produce`
// threw a resume-time trap — and BOTH hand control back to a wasm activation,
// so both take the claim. The success arm has always called
// `consumeClaimIfRunning()` first: when the code delivering the resume is a
// RUNNING guest activation that itself holds the live claim (a
// `subtask.cancel` settling a parked callee from inside its own frame), that
// claim's window is closed. Mechanism A of #158 was the trap arm missing that
// call, so the same delivery shape with a trapping `produce` tripped the
// assert — and the assert preempted `#fail(e)`, so the parked guest received
// an AssertionError instead of its trap. These tests pin the fixed symmetry.
//
// Mechanism B of #158 (a second engine-driven resumption in one turn, from an
// activation that is NOT the claim holder — single-slot claim capacity) is
// deliberately NOT fixed here; the last test pins its current asserting
// behavior so a future fix flips it loudly.
//
// Scaffolding follows park_state_settle_test.ts. NOTE: the ambient state
// (resumingThread, activationClaims, threadStack) is MODULE-GLOBAL, so every
// test cleans up in a `finally`.

import {
  clearResumingThread,
  ComponentInstanceState,
  hasResumingThread,
  instancePoisonCause,
  isInstancePoisoned,
  popCurrentThread,
  pushCurrentThread,
  releaseActivationAmbient,
  setResumingThread,
  Store,
  Task,
  type TaskOptions,
  Thread,
  WaitableSet,
  withActivation,
} from "../src/task/mod.ts";
import { createWaitableSetWait } from "../src/intrinsics/async_builtins.ts";
import {
  blockCurrentActivation,
  type SuspensionPoint,
} from "../src/jspi/mod.ts";
import { Trap } from "../src/cabi/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";
import type { ResolvedOptions } from "../src/exec/boundary.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const ASYNC_FT: FuncType = { params: [], results: [], async: true };
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

function mkMemoryView() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return {
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
}

function opts(
  inst: ComponentInstanceState,
  over: Partial<ResolvedOptions> = {},
): ResolvedOptions {
  return {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: mkMemoryView() as any,
    realloc: null,
    postReturn: null,
    callback: null,
    async: false,
    cancellable: false,
    coreType: { params: ["i32", "i32"], results: ["i32"] },
    instance: inst,
    ...over,
  };
}

function mkWorld() {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
  task.state = "started";
  const thread = new Thread(task, (function* () {})());
  // The engine-resume claim names `task.implicitThread` — set it, as a real
  // lifted call's `enterImplicitThread` would.
  task.implicitThread = thread;
  return {
    store,
    inst,
    task,
    thread,
    point(): SuspensionPoint<unknown> | undefined {
      return store.waiting.find(
        (w) =>
          typeof (w as { resume?: unknown }).resume === "function" &&
          typeof (w as { abandon?: unknown }).abandon === "function",
      ) as SuspensionPoint<unknown> | undefined;
    },
    run<T>(fn: () => T): T {
      pushCurrentThread(thread);
      try {
        return fn();
      } finally {
        popCurrentThread(thread);
      }
    },
  };
}

/** Park `w`'s task on waitable-set.wait; resuming with no pending event makes
 * `produce` throw (the trap-at-resume-time arm), resuming cancelled succeeds. */
function parkOnWait(w: ReturnType<typeof mkWorld>, cancellable: boolean) {
  const wset = new WaitableSet();
  const seti = w.inst.handles.add(wset);
  const o = opts(w.inst, { cancellable });
  const ctx = {
    componentInstance: () => w.inst,
    options: () => o,
    resultTypes: () => [],
  };
  const wait = createWaitableSetWait({ options: 0 }, ctx, w.inst, "jspi");
  const parked = w.run(() => wait(seti, 0));
  assert(parked instanceof Promise, "the wait parked");
  const point = w.point();
  assert(point !== undefined, "the suspension point is waiting");
  return { wset, seti, parked: parked as Promise<unknown>, point: point! };
}

function cleanupAmbient(...worlds: ReturnType<typeof mkWorld>[]) {
  clearResumingThread();
  for (const w of worlds) releaseActivationAmbient(w.thread);
}

/** Deno fails a file on unhandled rejections; the parked promises here are
 * rejected deliberately and inspected (or ignored) by the tests. */
type Outcome = { ok: true; v: unknown } | { ok: false; e: unknown };
function rejection(p: Promise<unknown>): Promise<Outcome> {
  return p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
}

Deno.test("resume success arm: delivery from the claim holder consumes the claim", () => {
  const caller = mkWorld();
  const callee = mkWorld();
  try {
    const parked = parkOnWait(callee, true);
    rejection(parked.parked); // handled: this park is abandoned by the test
    // The caller's activation was engine-resumed (claim live) and its wasm is
    // now running under its wasm-entry bracket, where it synchronously
    // delivers a cancellation whose `produce` SUCCEEDS (TASK_CANCELLED).
    setResumingThread(caller.thread);
    withActivation(caller.thread, () => parked.point.resume(true));
    assert(hasResumingThread(), "the callee's claim replaced the caller's");
  } finally {
    cleanupAmbient(caller, callee);
  }
});

Deno.test("resume trap arm: delivery from the claim holder consumes the claim too (#158 mechanism A)", async () => {
  const caller = mkWorld();
  const callee = mkWorld();
  try {
    const parked = parkOnWait(callee, false);
    const outcome = rejection(parked.parked);
    setResumingThread(caller.thread);
    let threw: unknown = null;
    try {
      // Resume with no pending event: `produce` throws — the
      // trap-at-resume-time arm of `#resumeInner`. Before the #158 fix this
      // arm claimed the resumed ambient WITHOUT `consumeClaimIfRunning()`,
      // so `setResumingThread` asserted and preempted `#fail(e)`.
      withActivation(caller.thread, () => parked.point.resume(false));
    } catch (e) {
      threw = e;
    }
    assert(
      threw === null,
      `no assertion may escape resume(); got: ${String(threw)}`,
    );
    // `resume` never rethrows a `produce` error — it goes to `#fail`, i.e. the
    // parked import Promise rejects and the engine turns that into a trap.
    const r = await outcome;
    assert(r.ok === false, "the parked promise rejected");
    const msg = String(r.e);
    assert(
      !msg.includes("two activations claim the resumed ambient"),
      `the guest must receive its own trap, not the #158 assertion: ${msg}`,
    );
    assert(hasResumingThread(), "the callee's unwind claim is live");
  } finally {
    cleanupAmbient(caller, callee);
  }
});

Deno.test("resume from an EMPTY bracket self-consumes via the claims-top fallback", () => {
  const a = mkWorld();
  const b = mkWorld();
  try {
    const parkedA = parkOnWait(a, true);
    const parkedB = parkOnWait(b, true);
    rejection(parkedA.parked), rejection(parkedB.parked); // handled
    // First resumption: B's cancellation delivered from outside any activation
    // (a driver / another store's scheduler) — claims B, both the
    // activation-ambient claim and the resuming slot.
    parkedB.point.resume(true);
    assert(hasResumingThread(), "B's claim is live");
    // Second resumption in the same turn, again from an empty bracket:
    // `activationOf()` is the entryStack top ?? the activation-claims top, and
    // after the first resume the claims top IS the resuming thread — so
    // `consumeClaimIfRunning` self-consumes and no assert fires. (Attribution
    // for B's pending chunk is lost, but that is a different hazard.)
    let threw: unknown = null;
    try {
      parkedA.point.resume(true);
    } catch (e) {
      threw = e;
    }
    assert(threw === null, `expected no assert, got: ${String(threw)}`);
  } finally {
    cleanupAmbient(a, b);
  }
});

Deno.test("resume from a DIFFERENT running activation while a claim is live still asserts (#158 mechanism B)", () => {
  // PINS CURRENT BEHAVIOR ON PURPOSE. This is issue #158's mechanism B — the
  // resumed-ambient claim has a single slot, so a resumption delivered by an
  // activation that is NOT the claim holder cannot be reconciled by
  // `consumeClaimIfRunning`. The design decision (claim capacity) is still
  // pending on #158 and was deliberately NOT made by the mechanism-A fix.
  // When mechanism B is addressed, this test flips loudly rather than
  // silently absorbing the change.
  const x = mkWorld(); // the activation actually running (a dispatched tail's
  // guest chunk, under its own wasm-entry bracket)
  const y = mkWorld(); // the claimed-but-not-yet-run activation
  const z = mkWorld(); // the parked activation X delivers to
  try {
    const parkedZ = parkOnWait(z, true);
    rejection(parkedZ.parked); // handled
    // Y's suspension was settled (claim live), Y's engine chunk has not run.
    setResumingThread(y.thread);
    // X's guest chunk synchronously delivers a cancellation to Z — the SUCCESS
    // arm, whose `consumeClaimIfRunning` compares activationOf() (= X) against
    // the claim (= Y) and correctly declines to consume.
    let threw: unknown = null;
    try {
      withActivation(x.thread, () => parkedZ.point.resume(true));
    } catch (e) {
      threw = e;
    }
    assert(threw !== null, "expected the mechanism-B throw");
    assert(
      String(threw).includes("two activations claim the resumed ambient"),
      `expected the #158 assertion, got: ${String(threw)}`,
    );
  } finally {
    cleanupAmbient(x, y, z);
  }
});

Deno.test("guest-shaped: a trapping cancellation delivery while the canceller's claim is live (#158 mechanism A)", async () => {
  // The f7abf96 class ("request_cancellation: a trap during delivery poisons
  // the callee", task_test.ts) on the SuspensionPoint arm: the callee is
  // parked in a cancellable built-in whose `produce` traps when handed
  // `cancelled`, and the canceller delivers it while still holding its own
  // engine-resume claim.
  const callee = mkWorld();
  const canceller = mkWorld();
  try {
    const parked = callee.run(() =>
      blockCurrentActivation<number>({
        store: callee.store,
        task: callee.task,
        readyFunc: null,
        cancellable: true,
        produce: (cancelled) => {
          if (cancelled) throw new Trap("boom during cancel delivery");
          return 0;
        },
      })
    );
    const outcome = rejection(parked);
    const point = callee.point();
    assert(point !== undefined, "the suspension point is waiting");

    setResumingThread(canceller.thread);
    let threw: unknown = null;
    try {
      withActivation(
        canceller.thread,
        () => callee.task.requestCancellation(null),
      );
    } catch (e) {
      threw = e;
    }
    assert(
      !String(threw).includes("two activations claim the resumed ambient"),
      `the #158 assertion must not preempt the trap: ${String(threw)}`,
    );
    assert(
      callee.task.state === "cancel-delivered",
      `parity: the state is set first, got ${callee.task.state}`,
    );
    // `SuspensionPoint.resume` never rethrows a `produce` error: the trap
    // reaches the guest as a rejection of the import's Promise (the engine
    // turns it back into a wasm trap), so `requestCancellation` sees no throw
    // on this arm and the instance-poisoning branch of its catch does not run.
    // See the report on #158: whether the SP arm should also poison is a
    // separate question from the mechanism-A claim asymmetry fixed here.
    const r = await outcome;
    assert(r.ok === false, "the parked promise rejected");
    assert(
      String(r.e).includes("boom during cancel delivery"),
      `the guest receives its own trap: ${String(r.e)}`,
    );
    assert(
      isInstancePoisoned(callee.inst) === false &&
        instancePoisonCause(callee.inst) === undefined,
      "pinning current behavior: the SP arm does not poison the callee",
    );
  } finally {
    cleanupAmbient(callee, canceller);
  }
});
