// Hand-written usage sample for the generated `resources.ts` facade —
// exercises the resource-handle branded type and the method/static/
// constructor naming convention at `deno check` time.

import { bind } from "../generated/resources.ts";
import type { Counter, ResourcesExports } from "../generated/resources.ts";
import type { ComponentHandle } from "../../../src/exec/mod.ts";

export function useResources(handle: ComponentHandle) {
  const exports: ResourcesExports = bind(handle);
  const counters = exports["component-engine:resources/counters"];

  const c: Counter = counters["[constructor]counter"](0n);
  const bumped: bigint = counters["[method]counter.increment"](c);
  const value: bigint = counters["[method]counter.get"](c);

  const c2: Counter = counters["make-counter"](10n);
  const merged: Counter = counters["[static]counter.merge"](c, c2);
  const summed: bigint = counters["sum-both"](c, c2);
  const afterBump: bigint = counters["bump"](c, 5n);
  const consumed: bigint = counters["consume"](merged);
  const alive: number = counters["live-counters"]();

  return { bumped, value, summed, afterBump, consumed, alive };
}
