// Firefox lane expectation — a findings lane (best-effort, non-gating).
//
// RESULT (2026-08-09, Firefox/153.0 via playwright 1.62.1, linux-arm64,
// headless, launched with `javascript.options.wasm_js_promise_integration =
// true`): **the lane runs the full corpus.** All 59 files, 1395 commands,
// 25.7 s wall clock.
//
// ENGINE FINDINGS
// ---------------
// 1. JSPI WORKS on Firefox behind the pref, end to end. The in-page probe
//    (`harness/browser/entry.ts` `probeJspi`) builds a module with a
//    `Suspending` import, wraps the export with `WebAssembly.promising`, and
//    gets the suspended value back: `{suspending: true, promising: true,
//    roundTrip: true}`. docs/architecture.md §12 (Risks) lists "Firefox: flagged" as an accepted
//    risk and §13 M3 budgets a pref flip; the flip is sufficient — no
//    SpiderMonkey JSPI bug is visible from this corpus. Nothing in the M2
//    empirical pins (a)-(j) misfires here: with the runtime's ambient made
//    explicit (M3A-1, below), Firefox reproduces the Deno lane command for
//    command.
// 2. ONE genuine SpiderMonkey variance, in trap wording:
//    `async/builtin-trap-poisons-instance.wast:9` expects
//    "wasm trap: wasm `unreachable` instruction executed"; SpiderMonkey says
//    "unreachable executed". Per docs/architecture.md §1 the suite's `assert_trap` text is de
//    facto wasmtime/V8 wording, so this is an expected cross-engine
//    difference in message text, not a behavioural one — the trap happens,
//    at the right place, and poisons the instance as the spec requires.
//
// FINDING M3A-1 IS CLOSED. This file used to carry 80 further entries,
// identical to Chromium's, for the runtime's `node:async_hooks` dependency.
// Track M3A-1 removed that dependency from `runtime/src` (see
// `harness/browser/expectations/chromium.ts` for the summary), so SpiderMonkey
// now reproduces the Deno lane exactly apart from the trap wording above.

import type { LaneExpectation } from "./types.ts";

export const firefox: LaneExpectation = {
  lane: "firefox",
  required: false,
  notes:
    "Firefox 153 + javascript.options.wasm_js_promise_integration. JSPI verified working end to end. " +
    "Exactly 1 delta: SpiderMonkey trap wording. FINDING M3A-1 is fixed in the runtime, so the rest of the corpus is Deno-identical.",
  deltas: [
    {
      file: "async/builtin-trap-poisons-instance.json",
      line: 9,
      kind: "expected-fail",
      reason:
        "ENGINE: this engine words the unreachable trap differently; the suite's assert_trap text is de facto wasmtime/V8 wording (docs/architecture.md §1)",
    },
  ],
  // Findings lane: totals are recorded for drift detection but the driver
  // does not gate on them (`required: false`).
  totals: {
    commands: 1395,
    executed: 1349,
    passed: 1249,
    failed: 0,
    xfail: 100,
    pendingRuntime: 41,
    pendingCapability: 0,
    unsupportedDirective: 5,
  },
};

export default firefox;
