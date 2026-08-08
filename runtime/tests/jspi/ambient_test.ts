// Two platform facts about JSPI resumption that decide how the scheduler's
// ambient "current thread" can work at all. Both were established
// experimentally in M2 phase 3d; pinning them here so the next change to the
// ambient mechanism cannot silently invalidate its premise.
//
// See `setResumingThread` in runtime/src/task/scheduler.ts for the mechanism
// these two facts justify.

import { AsyncLocalStorage } from "node:async_hooks";
import { assertEq } from "../support/asserts.ts";
import { isSupported } from "../../src/jspi/mechanics.ts";
import { instantiateActivation } from "./support.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

Deno.test({
  name: "jspi pin (h): AsyncLocalStorage DOES propagate across a resumption",
  ignore: !isSupported(),
  fn: async () => {
    // The engine registers its resumption continuation on our Promise at
    // *suspension* time — inside our own frame, where the async context is
    // live — so the resumed activation inherits it. A post-resumption built-in
    // call therefore CAN recover an ambient identity from an
    // `AsyncLocalStorage`.
    //
    // Note the shape of the observation: the fixture must call the import
    // TWICE (`run_twice`). A single-call export gives you no post-resumption
    // call to look at, and reading an unset key then looks exactly like
    // "context lost" — which is how an earlier probe of this reached the
    // opposite (wrong) conclusion.
    //
    // The runtime does not currently depend on this: the `resumingThread`
    // mechanism (task/scheduler.ts) rests on pin (i) below, which needs no
    // async-context support at all. This pin records that ALS is a viable
    // alternative, and guards the claim if we ever switch to it.
    const als = new AsyncLocalStorage<string>();
    const seen: Record<string, string | undefined> = {};
    let n = 0;
    const block = new WebAssembly.Suspending((x: number) => {
      n++;
      seen[`call${n}`] = als.getStore();
      return n === 1
        ? new Promise<number>((r) => setTimeout(() => r(x), 0))
        : x;
    });
    const exports = await instantiateActivation({ block });
    const run = WebAssembly.promising(
      exports.run_twice as (x: number) => number,
    );
    await als.run("A", () => run(7));
    assertEq(seen.call1, "A"); // before suspension: context is live
    assertEq(seen.call2, "A"); // after resumption: it survived
  },
});

Deno.test({
  name: "jspi pin (i): a resumed activation runs BEFORE our own continuation",
  ignore: !isSupported(),
  fn: async () => {
    // This is the ordering the `resumingThread` mechanism relies on. Settling
    // a Suspending import's Promise hands control to wasm, and the resumed
    // activation runs its built-ins *before* the promising Promise settles and
    // before our await continuation. Combined with JS being single-threaded,
    // that makes "between resolve(T) and our next turn, any empty-bracket
    // built-in call belongs to T" airtight rather than hopeful.
    const log: string[] = [];
    let resolve!: (v: number) => void;
    let n = 0;
    const block = new WebAssembly.Suspending((x: number) => {
      n++;
      log.push(`host-call-${n}`);
      return n === 1 ? new Promise<number>((r) => (resolve = r)) : x;
    });
    const exports = await instantiateActivation({ block });
    const run = WebAssembly.promising(
      exports.run_twice as (x: number) => number,
    );
    const p = run(7);
    p.then(() => log.push("promising-settled"));
    log.push("before-resolve");
    resolve(1);
    log.push("sync-after-resolve");
    await p;
    log.push("our-continuation");

    assertEq(log, [
      "host-call-1", // suspends here
      "before-resolve",
      "sync-after-resolve", // resolve() is not synchronous re-entry
      "host-call-2", // the RESUMED activation, before anything of ours
      "promising-settled",
      "our-continuation",
    ]);
    assert(
      log.indexOf("host-call-2") < log.indexOf("our-continuation"),
      "the resumed activation must run before we regain control",
    );
  },
});
