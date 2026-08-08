// Claim (b) — PLAN.md §5: the frame rule.
//
// wasm₁ → JS glue → wasm₂ → Suspending import returning a Promise. Spec says
// this traps because a JS frame sits between the promising entry and the
// Suspending call. Pin the EXACT observed error: constructor, message,
// timing (synchronous throw from the `promising`-wrapped call, vs an
// asynchronous rejection).
//
// This is the single fact PLAN.md §5 calls load-bearing for the whole JSPI
// phase (cross-component adapters must be wasm, not JS, or they trap the
// moment anything below them suspends).

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("frame rule: JS glue between promising entry and Suspending import traps with SuspendError", async () => {
  // Leaf instance: a genuine suspension point (Suspending import returning a
  // real, not-yet-resolved Promise).
  const leaf = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) =>
      new Promise((resolve) => setTimeout(() => resolve(x * 2), 5))
    ),
  });

  // Root instance: run_via_glue(x) calls $glue(x), which we bind to a plain
  // (non-Suspending) JS function that synchronously calls into `leaf.run` —
  // inserting a JS frame between root's promising entry and leaf's
  // Suspending call.
  const root = await instantiateActivation({
    block: (x: number) => x, // unused on this path
    glue: (x: number) => leaf.run(x),
  });

  const runPromising = WebAssembly.promising(root.run_via_glue);

  // OBSERVED (Deno 2.9.5 / V8 15.0.245.2-rusty): the trap surfaces as an
  // *asynchronous Promise rejection* from the value returned by the
  // `promising`-wrapped call — the call itself returns a Promise
  // successfully (suspension is attempted lazily, only once the wasm
  // activation actually reaches the Suspending import), and that Promise
  // then rejects. This matters for the JSPI phase: a bare `try/catch` around
  // the call site is NOT sufficient — callers must `.catch()`/`await` the
  // returned Promise.
  let threw: unknown = undefined;
  let sawPromiseReject = false;
  try {
    const p = runPromising(5);
    // If it didn't throw synchronously, see if it rejects instead.
    try {
      await p;
    } catch (e) {
      sawPromiseReject = true;
      threw = e;
    }
  } catch (e) {
    threw = e;
  }

  assertEquals(threw instanceof Error, true, "expected an Error to surface");
  const err = threw as Error;
  // WebAssembly.SuspendError is the observed constructor name.
  assertEquals(err.constructor.name, "SuspendError");
  assertEquals(err.message, "trying to suspend JS frames");
  // Document which path we actually observed (informational — either is a
  // legitimate spec-conformant surfacing, but the JSPI phase needs to know
  // which one to code against).
  assertEquals(
    sawPromiseReject,
    true,
    "OBSERVED: traps via Promise rejection, not a synchronous throw from promising()",
  );
});
