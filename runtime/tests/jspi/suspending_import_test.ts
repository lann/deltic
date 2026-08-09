// Claim (c) — docs/architecture.md §5: Suspending import returning a NON-promise value —
// no suspension, value passes through (the "fast path"). Also pins a
// related, non-obvious fact: calling a Suspending-wrapped import OUTSIDE a
// `promising`-wrapped activation always traps, regardless of whether the
// underlying function would have returned a Promise or not.

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("Suspending import returning a non-Promise value: fast path, no suspension", async () => {
  let called = 0;
  const exp = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) => {
      called++;
      return x * 2; // plain number, not a Promise
    }),
  });

  const runPromising = WebAssembly.promising(exp.run);
  const result = await runPromising(5);
  // block(5) = 10 (no suspension happened); run() = block(x) + 1 = 11.
  assertEquals(result, 11);
  assertEquals(called, 1);
});

Deno.test("Suspending import called OUTSIDE a promising activation traps unconditionally (even for non-Promise returns)", async () => {
  // deno-lint-ignore no-explicit-any
  const attempts: Array<() => any> = [];

  // Case 1: block would return a Promise.
  const expA = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) => Promise.resolve(x * 2)),
  });
  attempts.push(() => expA.run(4)); // direct call, no promising() wrapper

  // Case 2: block would return a plain value (still traps — the engine
  // does not special-case this; the "fast path" from claim (c) only
  // applies to calls made from WITHIN a promising activation).
  const expB = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) => x * 3),
  });
  attempts.push(() => expB.run(4));

  for (const attempt of attempts) {
    let err: unknown;
    try {
      attempt();
    } catch (e) {
      err = e;
    }
    assertEquals(err instanceof Error, true, "expected a trap");
    const e = err as Error;
    assertEquals(e.constructor.name, "SuspendError");
    assertEquals(e.message, "trying to suspend without WebAssembly.promising");
  }
});
