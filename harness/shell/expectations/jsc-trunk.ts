// JSC trunk lane expectation — a findings lane (best-effort, non-gating;
// issue #22). SEEDED, pending the first CI run: the `jsc-built-products`
// channel is x86_64-only, and this track was implemented on an aarch64 host
// (per issue #22: "first CI run should sanity-probe the jsc-built-products
// binary … but never executed here; wrong local arch"). `totals: null` means
// the driver (`tools/shell/run-lane.ts` -> `tools/browser/classify.ts`
// `diffTotals`) skips the TOTAL-row check entirely until a real run seeds it
// — verified: `diffTotals` only runs `if (exp.totals)`.
//
// MACHINERY VALIDATION (not a parity target — do NOT read this as JSC
// trunk's expected shape): the driver, entry, bundler, and protocol were all
// exercised end-to-end locally against a STABLE jsc 2.52 (GTK, extracted
// from the Debian/Ubuntu `libjavascriptcoregtk-bin` .deb — recipe in
// `tools/shell/run-lane.ts`'s header) via:
//
//   deno run -A tools/shell/run-lane.ts jsc \
//     --shell-bin /path/to/jsc --lib-path /path/to/libdir
//
// Expected (and observed) on that stable build per issue #22's empirical
// table: capability matrix shows jspi=false, multiMemory=false (both land
// only in trunk); a large deviation report follows because JSPI-needing
// commands fail outright rather than classifying pending. That is a stable-
// build artifact of running the machinery early, not a jsc-trunk finding —
// no overlay entries are seeded from it. The first real CI run against
// jsc-built-products trunk is what populates `deltas`/`totals` here for
// real, the same way `spidermonkey-nightly.ts` was seeded from an actual
// nightly run.
//
// SHELL-SURFACE FACTS specific to jsc (see `tools/shell/entry.ts`,
// `tools/shell/polyfill.ts` for where these matter):
//   - `readFile(path, "binary")` (top-level global, not namespaced) for
//     binary reads.
//   - `-m <path>` (module mode) with positional args AFTER the module path
//     working reliably as `arguments` in the shell global — unlike
//     SpiderMonkey's `--module=`, this shell tolerated
//     `jsc -m file.mjs -- foo bar` cleanly, but the driver still passes no
//     positional args (parity with the SpiderMonkey invocation; the entry
//     needs none either way).
//   - `JSC_*` env vars for feature flags — an unknown one makes jsc exit
//     with an error, so nothing speculative is ever passed; this driver
//     passes none.
//   - unreachable trap wording: `"Unreachable code should not be executed"`
//     — already a `TRAP_MESSAGE_EQUIVALENTS` row in `harness/src/runner.ts`,
//     no matcher work needed here.

import type { ShellLaneExpectation } from "./types.ts";

export const jscTrunk: ShellLaneExpectation = {
  lane: "jsc",
  required: false,
  notes:
    "JSC trunk (jsc-built-products, x86_64 CI only). SEEDED — no CI run yet " +
    "(implemented on an aarch64 host; see this file's header). totals: null " +
    "so the driver skips the TOTAL-row check until the first real run.",
  deltas: [],
  totals: null,
};

export default jscTrunk;
