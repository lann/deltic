// Driver-level coverage for issue #156: a settled activation tail whose
// instance is not host-enterable is DEFERRED IN PLACE, and `driveAsync` must
// park (not spin) until the lock releases.
//
// Shape manufactured below — the reachable one from the issue's analysis:
//
//   * instance B's thread is parked on an `awaitValue` promise that has
//     already settled, so its tail sits in `store.settled`;
//   * sibling instance A is entered from the host (`enterFrom(null)`), which
//     under the shared synthetic per-instantiation root locks B too;
//   * the only way out is an outstanding host call whose settle releases the
//     lock — the async-dtor bracket's shape, registered in
//     `store.pendingHostCalls` with its `.then` attached BEFORE insertion,
//     mirroring `callDtorGated`.
//
// Pre-fix this either crashed (`resumeWith`'s enterability assert, reached
// through `serviceSettled`) or spun the driver hot with no await in the
// cycle. The host promise resolves from a `setTimeout(0)`, so passing
// requires the loop to genuinely park across a macrotask.

import { assertEq } from "./support/asserts.ts";
import { driveStoreAsync } from "../src/exec/boundary.ts";
import {
  type BlockRequest,
  type Cancelled,
  ComponentInstanceState,
  Store,
  Task,
  type TaskOptions,
  Thread,
} from "../src/task/mod.ts";
import type { FuncType } from "../src/cabi/types.ts";

const SYNC_FT: FuncType = { params: [], results: [], async: false };
const SYNC_OPTS: TaskOptions = {
  async_: false,
  callback: false,
  stringEncoding: "utf8",
  memory: null,
};

function spawn(
  task: Task,
  body: (t: Thread) => Generator<BlockRequest, void, Cancelled>,
): Thread {
  let thread!: Thread;
  thread = new Thread(
    task,
    (function* (): Generator<BlockRequest, void, Cancelled> {
      yield* body(thread);
    })(),
  );
  return thread;
}

Deno.test("driveAsync: a deferred tail parks the loop until the host entry leaves", async () => {
  const store = new Store();
  const a = new ComponentInstanceState(0, store);
  const b = new ComponentInstanceState(1, store);

  // B: parked on an awaitValue promise that settles immediately.
  const parkPromise = Promise.resolve(undefined);
  const order: string[] = [];
  const bTask = new Task(SYNC_FT, SYNC_OPTS, b, () => [], (() => {}) as never);
  const bThread = spawn(bTask, function* (thread) {
    yield* bTask.enterImplicitThread(thread);
    bTask.start();
    yield { readyFunc: null, cancellable: false, awaitValue: parkPromise };
    order.push("b tail ran");
    bTask.return_([]);
    bTask.exitImplicitThread(thread);
  });
  bThread.resume();
  // Let `noteAwaiting`'s eager continuation queue the tail.
  await Promise.resolve();
  await Promise.resolve();
  assertEq(store.settled.length, 1, "B's tail is queued");

  // A holds a host entry, which locks the shared root (and therefore B).
  a.enterFrom(null);
  assertEq(b.mayEnterFrom(null), false);

  // The outstanding host call whose settle releases the lock. `.then` is
  // registered BEFORE insertion, as `callDtorGated` does, so the driver's
  // race sees an entry that self-removes.
  let releaseHostCall!: () => void;
  const hostCall = new Promise<void>((r) => {
    releaseHostCall = r;
  });
  const gated = hostCall.then(() => {
    a.leaveTo(null);
    store.pendingHostCalls.delete(gated);
  });
  store.pendingHostCalls.add(gated);
  // Demonstrably a macrotask away: the driver must park, not spin.
  setTimeout(() => releaseHostCall(), 0);

  await driveStoreAsync(
    store,
    () => bTask.state === "resolved",
    "settled-deferral test",
  );

  assertEq(order.join(","), "b tail ran");
  assertEq(bTask.state, "resolved");
  assertEq(store.settled.length, 0);
  assertEq(store.awaiting.size, 0);
});
