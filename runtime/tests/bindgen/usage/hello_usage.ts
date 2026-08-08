// Hand-written usage sample exercising the generated `hello.ts` facade
// (PLAN.md §9 gate: "a hand-written usage sample per world must pass `deno
// check` against the generated types"). This file is type-checked by
// `deno task check`; it is not executed as a test (no runtime component
// here, just call-site type shape verification).

import type { WirePlan } from "../../../src/plan/mod.ts";
import { bind, verify, WORLD_DIGEST } from "../generated/hello.ts";
import type { ComponentHandle } from "../../../src/exec/mod.ts";

export async function useHello(handle: ComponentHandle, plan: WirePlan) {
  const mismatch = await verify(plan);
  if (mismatch) {
    throw new Error(
      `hello world digest mismatch: expected ${mismatch.expected}, got ${mismatch.actual}` +
        (mismatch.firstDivergence ? ` (${mismatch.firstDivergence})` : ""),
    );
  }
  const exports = bind(handle);
  const greeting: string = exports["greet"]("component model");
  return { greeting, digest: WORLD_DIGEST };
}
