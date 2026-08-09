// Shell-lane expectation overlay types (issue #22).
//
// Same shape and role as `harness/browser/expectations/types.ts` (imports
// `LaneDelta`/`LaneTotals` from there rather than redefining them — see this
// track's dispatch); only the `lane` tag differs, since these are engine
// shells, not browsers.

import type { LaneDelta, LaneTotals } from "../../browser/expectations/types.ts";
export type { LaneDelta, LaneTotals };
export { deltaKey } from "../../browser/expectations/types.ts";

export interface ShellLaneExpectation {
  lane: "spidermonkey" | "jsc";
  /** Human summary printed with the table. */
  notes: string;
  /** `true` = a red lane is a gate failure; `false` = findings-only lane.
   * Every canary lane in this track is `false` (issue #22: "findings lanes,
   * never gating"). */
  required: boolean;
  /** Expected per-file/line deltas against the Deno lane. */
  deltas: LaneDelta[];
  /** Expected TOTAL row. `null` = do not assert totals (e.g. jsc-trunk,
   * seeded pending its first CI run). */
  totals: LaneTotals | null;
  /**
   * Whole-file deltas: files this engine is not expected to complete at all
   * (e.g. a missing feature makes the executor unusable). Every command in
   * the file is exempted, with the reason recorded once.
   */
  fileDeltas?: { file: string; reason: string }[];
}
