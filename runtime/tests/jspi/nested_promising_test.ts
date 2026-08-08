// Claim (g) — PLAN.md §5/§6: nested promising. A promising-wrapped export A
// calls (through wasm) an import that itself was created from
// promising(another wasm export B). Does this compose?

import { assertEquals } from "./asserts.ts";
import { instantiateActivation } from "./support.ts";

Deno.test("nested promising: a Suspending import may itself return a Promise obtained from another promising() activation", async () => {
  // Leaf: an independent promising-suspendable activation with its own
  // genuine suspension point.
  const leaf = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) =>
      new Promise<number>((resolve) => setTimeout(() => resolve(x * 10), 5))
    ),
  });
  const leafPromising = WebAssembly.promising(leaf.run);

  // Root: its own Suspending import's JS body calls `leafPromising` and
  // returns THAT Promise, chaining root's suspension onto leaf's.
  const root = await instantiateActivation({
    block: new WebAssembly.Suspending((x: number) => leafPromising(x)),
  });
  const rootPromising = WebAssembly.promising(root.run);

  // OBSERVED: no trap — nested/chained promising activations compose freely.
  // leaf.run(5) = block_leaf(5) + 1 = (5*10) + 1 = 51.
  // root.run(5) = block_root(5) + 1 = leaf.run(5) + 1 = 52.
  const result = await rootPromising(5);
  assertEquals(result, 52);
});
