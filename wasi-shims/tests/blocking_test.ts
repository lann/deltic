// The parking kernel, unit level (io.ts): Pollable readiness/wake
// semantics, the timer constructor, and poll's fast-path/park split — no
// component involved (block/poll are @suspending-marked, but the marker
// only matters at the wasm boundary; direct JS calls are plain).
// The through-a-real-guest-frame pins live in blocking_guest_test.ts.

import { assertEq, assertTrue } from "./asserts.ts";
import { Pollable, poll } from "../src/io.ts";

const nowNs = (): bigint => BigInt(Math.round(performance.now() * 1e6));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("kernel: the default pollable is always ready and block() is synchronous", () => {
  const p = new Pollable();
  assertEq(p.ready(), true);
  // Sync fast path: no Promise, no park.
  assertEq(p.block(), undefined);
});

Deno.test("kernel: a timer pollable parks until its deadline", async () => {
  const p = Pollable.timer(nowNs() + 60_000_000n, nowNs); // 60ms
  assertEq(p.ready(), false, "not ready before the deadline");
  const t0 = performance.now();
  const parked = p.block();
  assertTrue(parked instanceof Promise, "unready block() returns a Promise");
  await parked;
  const elapsed = performance.now() - t0;
  assertTrue(elapsed >= 45, `parked ${elapsed}ms; expected ~60ms`);
  assertEq(p.ready(), true, "ready after the deadline");
  assertEq(p.block(), undefined, "block() is sync once ready");
});

Deno.test("kernel: an externally-woken pollable (the promise-swap producer shape)", async () => {
  // The interop seam a sockets provider uses: readiness over a queue,
  // wake by settling the current epoch's promise and re-arming.
  const queue: number[] = [];
  let wake!: () => void;
  let epoch = new Promise<void>((r) => (wake = r));
  const arrived = () => {
    const w = wake;
    epoch = new Promise<void>((r) => (wake = r));
    w();
  };
  const p = new Pollable(() => queue.length > 0, () => epoch);

  assertEq(p.ready(), false);
  const parked = p.block() as Promise<void>;
  let settled = false;
  parked.then(() => (settled = true));
  await sleep(20);
  assertEq(settled, false, "still parked with an empty queue");
  queue.push(42);
  arrived();
  await parked;
  assertEq(p.ready(), true);
});

Deno.test("kernel: poll takes the sync fast path when anything is ready", () => {
  const ready = new Pollable();
  const never = new Pollable(() => false, () => new Promise(() => {}));
  const result = poll([never, ready, never]);
  assertTrue(!(result instanceof Promise), "fast path returns synchronously");
  assertEq(JSON.stringify(result), "[1]");
});

Deno.test("kernel: poll parks and wakes with the ready index", async () => {
  const never = new Pollable(() => false, () => new Promise(() => {}));
  const timer = Pollable.timer(nowNs() + 40_000_000n, nowNs); // 40ms
  const t0 = performance.now();
  const result = poll([never, timer]);
  assertTrue(result instanceof Promise, "nothing ready: poll parks");
  assertEq(JSON.stringify(await result), "[1]");
  assertTrue(performance.now() - t0 >= 30, "woke no earlier than the timer");
});

Deno.test("kernel: poll on an empty list traps (unbranded throw)", () => {
  let raised: unknown;
  try {
    poll([]);
  } catch (e) {
    raised = e;
  }
  assertTrue(raised instanceof Error, `expected a throw, got ${raised}`);
  assertTrue(!(raised instanceof Promise), "trap is synchronous");
});
