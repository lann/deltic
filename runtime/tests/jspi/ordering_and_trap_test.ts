// Claim (e) — PLAN.md §5/§6: promising() Promise resolution ordering vs
// microtasks, and what happens when the wasm traps AFTER suspension+resume.

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("promising() resolution is ordered as a normal Promise in the microtask queue (no priority jump)", async () => {
  const order: string[] = [];
  const exp = await instantiateActivation({
    // Suspend then resolve immediately with an already-resolved Promise:
    // still forces at least one microtask hop through the JSPI machinery.
    block: new WebAssembly.Suspending((x: number) => Promise.resolve(x)),
  });

  const runPromising = WebAssembly.promising(exp.run);
  runPromising(5).then((v) => order.push(`promising-resolved:${v}`));
  Promise.resolve().then(() => order.push("microtask-A"));
  Promise.resolve().then(() => order.push("microtask-B"));

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // OBSERVED (Deno 2.9.5 / V8 15.0.245.2-rusty): microtasks queued
  // synchronously before the suspend/resume round-trip run first; the
  // promising() continuation needs extra internal microtask hops (it is not
  // treated as "already resolved" even though `block`'s Promise was).
  // Implication for the JSPI phase: do not assume a promising() call that
  // "should" resolve immediately beats independently-queued microtasks —
  // ordering must be observed per engine, not assumed from the spec text.
  assertEquals(order[0], "microtask-A");
  assertEquals(order[1], "microtask-B");
  assertEquals(order[2], "promising-resolved:6");
});

Deno.test("wasm trapping AFTER a suspend/resume round-trip rejects the promising() Promise with the RuntimeError (not SuspendError)", async () => {
  const exp = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) =>
      new Promise((resolve) => setTimeout(() => resolve(x), 5))
    ),
  });

  // run_trap: calls block(x) (a real suspension point) then `unreachable`.
  const runPromising = WebAssembly.promising(exp.run_trap);
  let err: unknown;
  try {
    await runPromising(3);
  } catch (e) {
    err = e;
  }
  assertEquals(err instanceof Error, true, "expected a rejection");
  const e = err as Error;
  // OBSERVED: an ordinary core-wasm trap after resume surfaces as
  // WebAssembly.RuntimeError("unreachable") — the same shape as a
  // synchronous trap would, NOT wrapped or replaced by anything
  // JSPI-specific. Suspension machinery is transparent to normal trap
  // propagation once resumed.
  assertEquals(e.constructor.name, "RuntimeError");
  assertEquals(e.message, "unreachable");
});
