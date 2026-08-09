// Generates a lane-expectation overlay skeleton from a raw results JSON
// captured with `run-lane.ts --json <path>`.
//
//   deno run -A tools/browser/gen-overlay.ts /tmp/chromium.json > /tmp/o.ts
//
// It emits one `expected-fail` entry per command that failed on the browser
// lane and is NOT an xfail on the Deno lane, with a reason drawn from the
// classifier below. The output is a STARTING POINT: every reason must be read
// and, where the classifier guessed, replaced by a real triage note. Nothing
// here is applied automatically — the overlay files are checked in by hand.

import { isXfail } from "../../harness/src/xfail.ts";

/** Failure-signature -> root-cause label. Order matters (first match wins). */
const CLASSES: [RegExp, string][] = [
  // ---- engine variance (the reason the stretch lanes exist) --------------
  [
    /there can at most be one Memory section|Memory section has more than one memory/,
    "ENGINE (JavaScriptCore): multi-memory is not implemented — JSC rejects the core module at compile time",
  ],
  [
    /expected trap "wasm trap: wasm `unreachable` instruction executed", got/,
    "ENGINE: this engine words the unreachable trap differently; the suite's assert_trap text is de facto wasmtime/V8 wording (docs/architecture.md \u00a71)",
  ],
  [
    /exit-sync-call with an empty sync-call stack|transfer-borrow outside an enter-sync-call/,
    "M3A-1 (no AsyncLocalStorage in browsers): the FACT sync-call bracket lost its activation ambient across an await",
  ],
  [
    /a resumed-activation claim was never released/,
    "M3A-1: `consumeClaimIfRunning` never fires because the shimmed ALS reports no store outside a synchronous extent",
  ],
  [
    /two activations claim the resumed ambient at once/,
    "M3A-1: the one-claimant assert trips because the claim could not be consumed without an ALS store",
  ],
  [
    /task\.return from a non-async task/,
    "M3A-1: `resolveAmbient` fell through to the wrong tier and named a non-async task, so `task.return` rejected a legitimate call",
  ],
  [
    /instantiation-time task context/,
    "M3A-1 cascade: a built-in ran with no resolvable ambient and was classified pending-capability",
  ],
  [
    /reentrance forbidden|no current instance|no definition named|table entry empty|wasm `unreachable`|Converting circular structure/,
    "CASCADE: an earlier command in this same file failed, leaving the component definition / instance state wrong for every later command. Root cause = the first non-CASCADE delta listed above it in this file.",
  ],
];

function reasonFor(detail: string): string {
  for (const [re, why] of CLASSES) if (re.test(detail)) return why;
  return "UNTRIAGED — classify this before checking the overlay in";
}

const path = Deno.args[0];
if (!path) {
  console.error("usage: gen-overlay.ts <raw-results.json>");
  Deno.exit(2);
}
const raw = JSON.parse(await Deno.readTextFile(path));
const lane: string = raw.lane;

const lines: string[] = [];
let untriaged = 0;
for (const f of raw.files) {
  for (const r of f.results) {
    if (r.status !== "failed") continue;
    if (isXfail(f.path, r.line)) continue;
    const reason = reasonFor(String(r.detail ?? ""));
    if (reason.startsWith("UNTRIAGED")) untriaged++;
    lines.push(
      `  { file: ${JSON.stringify(f.path)}, line: ${r.line}, ` +
        `kind: "expected-fail", reason: ${JSON.stringify(reason)} },`,
    );
  }
}
console.error(
  `[gen-overlay] ${lane}: ${lines.length} deltas, ${untriaged} untriaged`,
);
console.log(lines.join("\n"));
