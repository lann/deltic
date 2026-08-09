// `wasi:clocks@0.2` + `wasi:clocks@0.3` (contracts/embedder-api.md
// §"WASI examination"; the D-1 union clock — tools/smoke-c0/REPORT.md
// finding D-1: `monotonic-clock@0.3.0` exposes different function sets
// across the consumer corpus (`wait-for` vs `now`+`wait-until`) at the SAME
// version string — same track, divergent drafts, served by one union
// provider per contracts/embedder-api.md §"Version canonicalization").

import { Pollable } from "./io.ts";

export interface ClocksOptions {
  /** Override the monotonic clock's `now()` (nanoseconds); default `performance.now()`-derived. */
  now?: () => bigint;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** `wasi:clocks@0.2` + `wasi:clocks@0.3` provider fragment (two track keys). */
export function clocks(options: ClocksOptions = {}): { imports: Record<string, unknown> } {
  const nowFn = options.now ?? ((): bigint => BigInt(Math.round(performance.now() * 1e6)));
  // A coarse but honest resolution: this clock is JS-timer-backed, not a
  // real hardware tick; 1 microsecond avoids claiming false precision.
  const RESOLUTION_NS = 1_000n;

  const monotonic02 = {
    now: nowFn,
    resolution: (): bigint => RESOLUTION_NS,
    subscribeInstant: (_when: bigint): Pollable => new Pollable(),
    subscribeDuration: (_when: bigint): Pollable => new Pollable(),
  };

  const wallClock02 = {
    now: (): { seconds: bigint; nanoseconds: number } => {
      const ms = Date.now();
      return {
        seconds: BigInt(Math.floor(ms / 1000)),
        nanoseconds: (ms % 1000) * 1_000_000,
      };
    },
    resolution: (): { seconds: bigint; nanoseconds: number } => ({
      seconds: 0n,
      nanoseconds: 1_000_000,
    }),
  };

  // The D-1 union provider (C0-proven shape, tools/smoke-c0/leg2_exec_model.ts):
  // both drafts' functions live on the one `@0.3` track provider; per-leaf
  // structural resolution (contracts/embedder-api.md §"Version
  // canonicalization") lets each consumer link only the subset it imports.
  const monotonic03 = {
    now: nowFn,
    getResolution: (): bigint => RESOLUTION_NS,
    waitUntil: async (when: bigint): Promise<void> => {
      const deltaNs = when - nowFn();
      await sleep(Number(deltaNs) / 1e6);
    },
    waitFor: async (howLong: bigint): Promise<void> => {
      await sleep(Number(howLong) / 1e6);
    },
  };

  return {
    imports: {
      "wasi:clocks/monotonic-clock@0.2": monotonic02,
      "wasi:clocks/wall-clock@0.2": wallClock02,
      "wasi:clocks/monotonic-clock@0.3": monotonic03,
    },
  };
}
