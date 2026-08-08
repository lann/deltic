// Shared failure type for trampolines/intrinsics scheduled after the current
// milestone. Split out of ./mod.ts so sibling intrinsic modules can raise it
// without importing the (much larger) trampoline dispatcher.

/** Instantiate-time failure for functionality scheduled after M0. */
export class UnsupportedFeatureError extends Error {
  constructor(public milestone: "M1" | "M2" | "M2-streams" | "M2-jspi", what: string) {
    super(
      `${what} — scheduled for ${milestone}, not implemented in the current ` +
        `executor (contracts/intrinsics.md §B)`,
    );
    this.name = "UnsupportedFeatureError";
  }
}
