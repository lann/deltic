// Lane-expectation overlay types.
//
// `harness/src/xfail.ts` is the **Deno-lane truth** and is never edited from
// the browser lane. A lane overlay expresses only the *delta* between this
// engine and the Deno lane: commands that pass on Deno and are expected to
// fail here (or vice versa), each with a reason. That keeps every browser
// finding attributable to a named engine difference rather than diffused into
// a second xfail list.

export type DeltaKind =
  /** Passes (or xfails) on Deno; expected to FAIL on this engine. */
  | "expected-fail"
  /** An xfail on Deno that is expected to PASS here (engine does better). */
  | "expected-pass";

export interface LaneDelta {
  /** Corpus-relative path, e.g. `async/streams.json`. */
  file: string;
  line: number;
  kind: DeltaKind;
  reason: string;
}

export interface LaneTotals {
  commands: number;
  executed: number;
  passed: number;
  failed: number;
  xfail: number;
  pendingRuntime: number;
  pendingCapability: number;
  unsupportedDirective: number;
}

export interface LaneExpectation {
  lane: "chromium" | "firefox" | "webkit";
  /** Human summary printed with the table. */
  notes: string;
  /** `true` = a red lane is a gate failure; `false` = findings-only lane. */
  required: boolean;
  /** Expected per-file/line deltas against the Deno lane. */
  deltas: LaneDelta[];
  /** Expected TOTAL row. `null` = do not assert totals (stretch lanes). */
  totals: LaneTotals | null;
  /**
   * Whole-file deltas: files this engine is not expected to complete at all
   * (e.g. a missing feature makes the executor unusable). Every command in
   * the file is exempted, with the reason recorded once.
   */
  fileDeltas?: { file: string; reason: string }[];
}

export function deltaKey(file: string, line: number): string {
  return `${file}:${line}`;
}
