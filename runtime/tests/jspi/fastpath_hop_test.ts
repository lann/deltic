// Claim (j) — the Suspending "fast path" still suspends.
//
// Claim (c)'s pin (suspending_import_test.ts) showed a Suspending import
// returning a plain value "passes the value through with no suspension". That
// test could not distinguish "no suspension" from "suspension + immediate
// resume": it only awaited the final result. This pin makes the distinction
// observable — and the answer is that the suspension is REAL:
//
//   * the import's JS body runs synchronously (inside the wasm's call), but
//   * the wasm CONTINUATION after the import call is deferred to a microtask,
//     even for a plain-value return.
//
// Consequence (load-bearing for fact_calls.ts's determinacy park): a
// `promising`-wrapped activation that makes ANY Suspending call — even one
// answered from a ready value, e.g. `waitable-set.wait` with a pending
// event — cannot have completed by the time the JS that entered it regains
// control. The reference runs such a callee synchronously to completion
// (`canon_lift` drives the thread to its first real block point inside
// `canon_lower`), so a host that reports subtask state at entry-return time
// reports a state the reference can never observe: STARTED for a call that
// eagerly RETURNED. `async-start-call` therefore parks the caller until the
// callee's state is determinate; see fact_calls.ts.

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("Suspending fast path: import JS runs synchronously, but the wasm continuation is deferred to a microtask", async () => {
  const order: string[] = [];
  const exp = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) => {
      order.push(`import(${x})`);
      return x + 1; // plain value — the "fast path"
    }),
  });
  // run_twice calls block twice; if the fast path continued synchronously,
  // BOTH import calls would land before `after-call`.
  const run = WebAssembly.promising(exp.run_twice);
  order.push("before-call");
  const p = run(1);
  order.push("after-call");
  const result = await p;
  order.push("awaited");

  // OBSERVED (Deno 2.9.5 / V8 15.0.245.2-rusty): first import call is
  // synchronous; the second (i.e. the continuation after the first) is not.
  assertEquals(
    order.join(" | "),
    [
      "before-call",
      "import(1)", // synchronous: inside the promising call
      "after-call", // ... but the wasm did NOT continue past the import
      "import(2)", // the continuation ran on a microtask
      "awaited",
    ].join(" | "),
  );
  assertEquals(result, 4); // block(block(1)) + 1
});

Deno.test("nested promising from a plain import: same deferral, one level down", async () => {
  // The async-start-call shape: plain (non-Suspending) JS runs mid-activation
  // and enters a NESTED promising activation. The nested activation's own
  // Suspending fast-path call defers its continuation the same way, so the
  // plain JS regains control with the nested activation UNFINISHED — the
  // indeterminate window fact_calls.ts's park exists for.
  const order: string[] = [];
  const inner = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) => {
      order.push(`inner-import(${x})`);
      return x + 1;
    }),
  });
  const innerRun = WebAssembly.promising(inner.run_twice);
  const outer = await instantiateActivation({
    block: (x: number) => {
      order.push("outer-import-begin");
      void innerRun(x);
      order.push("outer-import-end"); // regains control before inner finishes
      return x;
    },
  });
  const outerRun = WebAssembly.promising(outer.run);
  await outerRun(1);
  await new Promise((r) => setTimeout(r, 1)); // let inner's hops drain
  assertEquals(
    order.join(" | "),
    [
      "outer-import-begin",
      "inner-import(1)",
      "outer-import-end",
      "inner-import(2)",
    ].join(" | "),
  );
});
