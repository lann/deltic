// #160 — a host-initiated resource destructor is an ordinary lifted call.
//
// Authority: definitions.py `canon_resource_drop` (line 2319) builds the dtor
// into a function instance and calls it through `Store.lift` with
// `CanonicalOptions(async_ = False)` / `FuncType([U32Type()], [], async_ =
// False)`. Before #160 the host-initiated path called `rt.dtor` bare while
// HOLDING `enterFrom(null)` across the returned promise, which produced two
// observable defects pinned below:
//
//   1. the dtor's own suspension points were unresumable — `Store.tick`'s
//      enterability filter (#155) skips a thread whose instance is not
//      host-enterable, and the held bracket made the impl exactly that, so
//      the completion promise (parked in `pendingHostCalls`, i.e. advertised
//      as *external* work) never settled and every driver waited forever;
//   2. the held bracket also locked the synthetic per-instantiation root for
//      the whole activation, so a SIBLING instance of the same component
//      looked non-enterable from the host — the macro-scale window of the
//      #156 class.
//
// Both are structural consequences of the missing Task/Thread, and both are
// gone now that the dtor runs through `createLiftedFunction`.

import { ResourceTypeInfo } from "../src/cabi/mod.ts";
import {
  ComponentInstanceState,
  Store,
  storeQuiescent,
} from "../src/task/mod.ts";
import { currentTask } from "../src/task/scheduler.ts";
import { blockCurrentActivation } from "../src/jspi/mod.ts";
import { driveStoreAsync, hostDtorCall } from "../src/exec/boundary.ts";
import { assertEq } from "./support/asserts.ts";

Deno.test("#160: a dtor parked on a scheduler-resumable suspension point completes", async () => {
  const store = new Store();
  const impl = new ComponentInstanceState(1, store);
  let flag = false;
  let finished = false;

  const rt = new ResourceTypeInfo(
    impl,
    ((rep: number) => {
      // `currentTask()` resolves to the DTOR'S OWN task — that is the fix:
      // under the old bare call the activation had no task at all, so a
      // built-in reached here signalled `PendingCapability` (or, worse,
      // attributed itself to whatever foreign task happened to be ambient —
      // the #24 class).
      const task = currentTask();
      assertEq(task !== null, true);
      return blockCurrentActivation({
        store,
        task,
        readyFunc: () => flag,
        cancellable: false,
        produce: () => {
          finished = true;
          assertEq(rep, 77);
          return undefined;
        },
      });
    }) as unknown as (rep: number) => void,
  );

  hostDtorCall(rt, 77);

  // The park happened, and the entry bracket was RELEASED at it: the impl is
  // host-enterable, which is precisely what lets `tick` resume the point
  // below. Pre-#160 this was `false` and the store wedged here forever.
  assertEq(finished, false);
  assertEq(impl.mayEnterFrom(null), true);
  assertEq(store.waiting.length >= 1, true);
  // NOT advertised as external work: the settlement needs this scheduler.
  assertEq(store.pendingHostCalls.size, 0);

  flag = true;
  await driveStoreAsync(store, () => storeQuiescent(store), "#160 dtor drain");

  assertEq(finished, true);
  assertEq(store.waiting.length, 0);
  assertEq(storeQuiescent(store), true);
  assertEq(impl.mayEnterFrom(null), true);
  assertEq(store.hostFailure, undefined);
});

Deno.test("#160/#156: a sibling instance stays enterable while a dtor is in flight", async () => {
  const store = new Store();
  const impl = new ComponentInstanceState(1, store);
  const sibling = new ComponentInstanceState(2, store);
  let resolveDtor: () => void = () => {};

  const rt = new ResourceTypeInfo(
    impl,
    (() => new Promise<void>((r) => (resolveDtor = r))) as unknown as (
      rep: number,
    ) => void,
  );
  hostDtorCall(rt, 5);

  // Pre-#160 the held `enterFrom(null)` locked the synthetic root shared by
  // the component's instances, so this was `false` for as long as the dtor
  // ran — an unrelated export call on `sibling` would have trapped with
  // "cannot enter component instance".
  assertEq(sibling.mayEnterFrom(null), true);
  assertEq(impl.mayEnterFrom(null), true);

  resolveDtor();
  await driveStoreAsync(store, () => storeQuiescent(store), "sibling drain");
  assertEq(sibling.mayEnterFrom(null), true);
  assertEq(impl.mayEnterFrom(null), true);
});
