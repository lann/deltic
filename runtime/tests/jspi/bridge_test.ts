// The JSPI ↔ scheduler bridge (runtime/src/jspi/bridge.ts).
//
// These tests exercise the bridge *without* an engine JSPI dependency: a
// `SuspensionPoint` is an ordinary `SchedulableThread` from the scheduler's
// point of view, which is the whole design claim — the phase-1 seam means the
// scheduler cannot tell a suspended wasm activation from a parked generator.
// The engine-level facts themselves are pinned by the sibling files in this
// directory.

import { assertEq } from "../support/asserts.ts";
import {
  assertModeConsistent,
  chooseMode,
  enterWasm,
  SuspensionPoint,
  suspendingImport,
} from "../../src/jspi/mod.ts";
import { isSupported } from "../../src/jspi/mechanics.ts";
import {
  ComponentInstanceState,
  Store,
  Task,
} from "../../src/task/mod.ts";
import type { FuncType } from "../../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const FT: FuncType = { params: [], results: [], async: true };
function mkTask(inst: ComponentInstanceState): Task {
  return new Task(
    FT,
    { async_: true, callback: true, stringEncoding: "utf8", memory: null },
    inst,
    () => [],
    () => {},
  );
}

Deno.test("bridge: a suspension point is just a parked thread to the scheduler", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const task = mkTask(inst);
  let flag = false;
  const point = new SuspensionPoint<number>(
    store,
    task,
    () => flag,
    false,
    () => 42,
  );
  // Registered in the store's waiting list exactly like a generator thread.
  assertEq(store.waiting.length, 1);
  assertEq(point.ready(), false);
  assertEq(store.tick(), false); // not ready: no progress
  flag = true;
  assertEq(point.ready(), true);
  assertEq(store.tick(), true); // the scheduler resumed it
  assertEq(await point.promise, 42);
  assertEq(store.waiting.length, 0);
});

Deno.test("bridge: resume delivers the cancelled flag to the value producer", () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const point = new SuspensionPoint<string>(
    store,
    mkTask(inst),
    () => true,
    true,
    (cancelled) => (cancelled ? "cancelled" : "normal"),
  );
  point.resume(true);
  return point.promise.then((v) => assertEq(v, "cancelled"));
});

Deno.test("bridge: a trap computed at resume time becomes a rejection", async () => {
  // Empirical fact (e): a post-resume trap arrives as an ordinary rejection of
  // the import's Promise, which the engine turns back into a wasm trap. So the
  // producer throwing must reject, not throw synchronously into the scheduler.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const boom = new Error("trap at resume");
  const point = new SuspensionPoint<number>(
    store,
    mkTask(inst),
    () => true,
    false,
    () => {
      throw boom;
    },
  );
  point.resume(); // must not throw here
  let caught: unknown;
  await point.promise.catch((e) => (caught = e));
  assertEq(caught, boom);
  assertEq(store.waiting.length, 0);
});

Deno.test("bridge: reentrance gates are ours and hold across a suspension", async () => {
  // Empirical fact (d): the engine freely permits reentering an instance while
  // one of its activations is suspended. The Component Model forbids it, so
  // the gate must be enforced by us and must survive the suspension — the
  // instance stays entered for as long as the activation is parked.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  inst.enterFrom(null); // an activation is in flight
  let flag = false;
  const point = new SuspensionPoint<number>(
    store,
    mkTask(inst),
    () => flag,
    false,
    () => 1,
  );
  // While suspended the instance is still un-enterable: a second host call
  // would trap, which is exactly what `createLiftedFunction` checks.
  assertEq(inst.mayEnterFrom(null), false);
  flag = true;
  store.tick;
  point.resume();
  await point.promise;
  // Still entered — resuming does not release the gate; leaving does.
  assertEq(inst.mayEnterFrom(null), false);
  inst.leaveTo(null);
  assertEq(inst.mayEnterFrom(null), true);
});

Deno.test("bridge: abandon rejects without resuming the guest", async () => {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const point = new SuspensionPoint<number>(
    store,
    mkTask(inst),
    () => false,
    false,
    () => 0,
  );
  const reason = new Error("torn down");
  point.abandon(reason);
  let caught: unknown;
  await point.promise.catch((e) => (caught = e));
  assertEq(caught, reason);
  assertEq(store.waiting.length, 0);
});

// ---------------------------------------------------------------------------
// The invariant, and degradation
// ---------------------------------------------------------------------------

Deno.test("bridge: mode is plain unless BOTH requested and supported", () => {
  assertEq(chooseMode(undefined), "plain");
  assertEq(chooseMode(false), "plain");
  // On this engine the answer depends on JSPI availability; either way it is
  // never "jspi" without an explicit opt-in.
  assertEq(chooseMode(true), isSupported() ? "jspi" : "plain");
});

Deno.test("bridge: JSPI-less degradation — plain mode wraps nothing", () => {
  // The M3 browser-matrix path (PLAN.md §13). On an engine without JSPI every
  // blocking site keeps raising its precise NeedsJspi, which requires that
  // plain mode leave both wrapping sites untouched — a `Suspending` import
  // reached from a non-promising activation traps unconditionally (fact (c)).
  const fn = (x: number) => x + 1;
  // Identity, not a wrapper — compared by reference on purpose.
  assert(enterWasm(fn, "plain") === fn, "plain mode must not wrap entries");
  assert(
    suspendingImport(fn, "plain") === fn,
    "plain mode must not wrap imports",
  );
  assertEq((enterWasm(fn, "plain") as (x: number) => number)(1), 2);
});

Deno.test("bridge: the invariant is checked, not hoped for", () => {
  // plain mode: neither site wrapped.
  assertModeConsistent("plain", false, false);
  // jspi mode: both sites wrapped.
  assertModeConsistent("jspi", true, true);
  // Any mixture is rejected — this is the configuration fact (c) makes fatal.
  for (
    const [mode, e, i] of [
      ["jspi", true, false],
      ["jspi", false, true],
      ["plain", true, false],
      ["plain", false, true],
    ] as const
  ) {
    let threw = false;
    try {
      assertModeConsistent(mode, e, i);
    } catch {
      threw = true;
    }
    assert(threw, `mixture (${mode}, entries=${e}, imports=${i}) must be rejected`);
  }
});
