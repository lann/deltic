// The L3 case-loop driver: instantiate the suite behind the embedder
// conventions, enumerate cases, execute them, emit canonical L4 results
// JSONL. Mirrors the semantics of polymorph-test's own JS legs
// (js/viewer/harness.mjs `runCases`/`runSuiteJsonl`) rather than reinventing
// a policy — an "introspecting host runner" per ARCHITECTURE.md Rule 3 must
// stay behaviorally equivalent to the layered path.
//
// L4 schema authority: polymorph-test crates/component-test-results/src/lib.rs
// (`Envelope`, `RunInfo`, `CaseResult`, `Status`, `Provenance`,
// `wire_vocabulary_pinned` test) — the canonical wire types; cross-checked
// against expected/verify-pipeline-fixture.jsonl and
// expected/verify-compose-sample.jsonl (golden samples of the same format).

import {
  type ComponentArtifacts,
  instantiate,
  Trap,
  WitError,
} from "../../runtime/src/embedder/mod.ts";
import { Context, testContextImportRecord } from "./context.ts";
import { analyzeImports, requireImportsResolved } from "./import-analysis.ts";
import {
  applies,
  firstExcluding,
  loadTagsInventory,
  tagsOf,
} from "./tags.ts";

/** The suite's `tests` interface id (wit/tests.wit `interface tests`, v0.1.0). */
export const TESTS_INTERFACE = "polymorph:test/tests@0.1.0";

export interface RunSuiteOptions {
  /**
   * Host imports for everything the suite needs OTHER than test-context
   * (WASI, SUT interfaces, …) — the same shape `instantiate` itself takes
   * (contracts/embedder-api.md §"Module wiring and instantiation"). The
   * runner adds `test-context` itself and errors on a collision (dispatch's
   * import-wiring spec); omit it here.
   */
  imports?: Record<string, unknown>;
  /** Envelope `target` (opaque implementation x environment key). */
  target: string;
  /**
   * Envelope `suite.name`. Per js/viewer/harness.mjs's `envelope()`: "the
   * suite name is normalized to the lockfile identity — the wasm file stem,
   * underscores"; callers may pass the kebab-case name as-is, this function
   * does the same normalization (`replaceAll("-", "_")`).
   */
  suiteName: string;
  /** Substring filter: non-matching cases are skipped entirely (no emit),
   * per js/viewer/harness.mjs `runCases`'s `only` handling. */
  only?: string;
  /**
   * Feature-tag scheduling (issue #25): the features this target LACKS —
   * js/viewer/harness.mjs's `missing`. Tag-gating activates whenever the
   * suite carries a `component-test:tags@0.1` inventory (src/tags.ts):
   * non-applicable cases emit `not-applicable` rows instead of executing,
   * and an enumerated case no record covers throws (inventory drift — the
   * run is unsound, not failing). Passing `missing` for a suite WITHOUT an
   * inventory is an error (gating requested but impossible — upstream's
   * runner refuses the same way rather than silently degrading).
   */
  missing?: string[];
  /**
   * Per-case wall-clock budget in ms (the `--case-timeout` runner option
   * documented in harness.mjs's `runSuiteJsonl` doc comment). On expiry the
   * case fails with `{"limit-exceeded":"case-timeout"}` provenance and the
   * loop moves on; JSPI attempts cannot be cancelled, so this is only safe
   * paired with `freshCases` (the default) — see below.
   */
  caseTimeoutMs?: number;
  /**
   * Fresh suite instance per case (default true). harness.mjs's doc comment
   * on `runSuiteJsonl`'s `freshCases` parameter: "a fresh instance per case
   * ... contains trap poisoning" and is required to pair with
   * `caseTimeoutMs` (an abandoned JSPI attempt keeps running until its
   * instance is dropped). Setting this false reuses one instance for the
   * whole run — legal, but a trapped case can poison every later one, exactly
   * as harness.mjs warns.
   */
  freshCases?: boolean;
  /** Opt in to JSPI-backed suspension; passed through to `instantiate`. */
  jspi?: boolean;
  /** Receives each output line (envelope, one per case, terminator),
   * WITHOUT a trailing newline — callers decide the line separator. */
  emit: (line: string) => void;
  /** Optional progress log, one call per case (mirrors harness.mjs's
   * `log?.(...)` callback). */
  log?: (msg: string) => void;
}

export interface RunCounts {
  passed: number;
  failed: number;
  skipped: number;
  /** Cases scheduled out as `not-applicable` (tag gating; harness.mjs `na`). */
  na: number;
  total: number;
}

/** `js/viewer/harness.mjs`'s `resolveTestsExport`, ported: the suite's
 * `tests` interface from an instantiated component, whichever spelling the
 * producer used (verbatim interface id is what this runtime always uses,
 * but the fallback costs nothing and documents the contract). */
// deno-lint-ignore no-explicit-any
function resolveTestsExport(exports: Record<string, any>): any {
  const tests = exports[TESTS_INTERFACE] ?? exports["tests"];
  if (tests === undefined) {
    throw new Error(
      `suite instance exports no '${TESTS_INTERFACE}' interface: ` +
        `${Object.keys(exports)}`,
    );
  }
  return tests;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function describeThrow(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Run one suite end to end: instantiate, enumerate, execute every case,
 * emit the complete results-JSONL stream (envelope, one line per case,
 * terminator) through `opts.emit`. Throws `MissingImportsError` up front
 * (contracts/embedder-api.md's `requiredImports`) if the caller's imports
 * cannot satisfy the suite, and a plain `Error` if the census is empty (an
 * empty selection is a run error, per component-test-results/src/lib.rs's
 * `fold_jsonl` and harness.mjs's `runSuiteJsonl` — both refuse it).
 */
export async function runSuite(
  artifacts: ComponentArtifacts,
  opts: RunSuiteOptions,
): Promise<RunCounts> {
  const provided = opts.imports ?? {};
  // Fail fast, translate-only, before any instantiate (gate 3's contract):
  // detect whether test-context is imported at all — a pre-composed bundle
  // with the provider already linked in must work with no test-context
  // wiring — and merge, erroring on any caller/runner collision.
  const analysis = requireImportsResolved(artifacts.plan, provided);
  const mergedImports = analysis.requiresTestContext
    ? { ...provided, ...testContextImportRecord() }
    : provided;

  const freshCases = opts.freshCases ?? true;

  const newTests = async () => {
    const inst = await instantiate(artifacts, mergedImports, {
      jspi: opts.jspi,
    });
    return resolveTestsExport(inst.exports);
  };

  const censusTests = await newTests();
  const census = await censusTests.all();

  // Feature-tag scheduling (issue #25): gate on the suite's own
  // `component-test:tags@0.1` inventory when it has one — the SDK embeds it
  // in the guest core module and it survives wac composition, so this
  // introspecting runner CAN see it (revising the earlier "cannot see the
  // tags section" stance recorded below). Suites without an inventory run
  // feature-blind exactly as before.
  const inventory = loadTagsInventory(artifacts.componentBytes);
  const missing = opts.missing ?? [];
  if (inventory === null && opts.missing !== undefined) {
    throw new Error(
      "missing-features given, but the suite carries no " +
        "component-test:tags@0.1 inventory (not built with their SDK, or " +
        "sections stripped) — tag gating is impossible, refusing to " +
        "silently run feature-blind",
    );
  }

  const suiteName = opts.suiteName.replaceAll("-", "_");
  const artifactSha256 = await sha256Hex(artifacts.componentBytes);
  opts.emit(JSON.stringify({
    "component-test-results": "0.1",
    target: opts.target,
    suite: { name: suiteName, "artifact-sha256": artifactSha256 },
    // "tags" when this run schedules against the suite's tag inventory,
    // "none" for inventory-less suites (component-test-results/src/lib.rs
    // `RunInfo`: "none" is for producers that cannot see the tags section
    // — with the inventory in hand, this runner no longer is one).
    run: { segment: 0, scheduling: inventory !== null ? "tags" : "none" },
  }));

  if (census.length === 0) {
    // Both authorities refuse this: component-test-results/src/lib.rs
    // `fold_jsonl` ("empty selection is a run error") and harness.mjs
    // `runSuiteJsonl` ("suite enumerated zero cases").
    throw new Error(
      "suite enumerated zero cases (empty selection is a run error)",
    );
  }

  const counts: RunCounts = { passed: 0, failed: 0, skipped: 0, na: 0, total: 0 };

  for (const [i, testCase] of census.entries()) {
    const name = String(await testCase.name());
    counts.total++;
    // js/viewer/harness.mjs `runCases`: "if (only && !name.includes(only))
    // continue" — a filtered-out case is skipped entirely, no emit.
    if (opts.only && !name.includes(opts.only)) continue;

    // harness.mjs `runCases` mark scheduling, in its exact order: `only`
    // first (above), then drift, then applicability. The N/A row's shape is
    // the embed runner's (expected/verify-pipeline-fixture.jsonl):
    // status, first excluding mark as detail, diagnostics-complete true.
    if (inventory !== null) {
      const tags = tagsOf(inventory, name);
      if (tags === undefined) {
        throw new Error(`inventory drift: no tags record covers ${name}`);
      }
      if (!applies(tags, missing)) {
        counts.na++;
        opts.emit(JSON.stringify({
          case: name,
          status: "not-applicable",
          detail: firstExcluding(tags, missing),
          "diagnostics-complete": true,
        }));
        opts.log?.(`${name} … not-applicable`);
        continue;
      }
    }

    // js/viewer/harness.mjs `runCases`' `freshCases` branch: re-enumerate
    // from a fresh instance and run the matching case; a vanished case is
    // inventory drift, not a failing case, and throws.
    let executed = testCase;
    if (freshCases) {
      const freshTests = await newTests();
      const freshList = await freshTests.all();
      const match = await findByName(freshList, name);
      if (match === undefined) {
        throw new Error(`case '${name}' vanished on re-enumeration`);
      }
      executed = match;
    }

    const diags: string[] = [];
    // The host-side `test-context` sideband: `diagnostic` calls are consumed
    // concurrently with `run` per wit/tests.wit's doc comment — here that is
    // automatic (same event loop turn, synchronous push into `diags`).
    const ctx = new Context((msg: string) => diags.push(msg));

    const start = performance.now();
    // deno-lint-ignore no-explicit-any
    let event: Record<string, any>;
    try {
      const attempt = executed.run(ctx);
      let timedOut = false;
      if (opts.caseTimeoutMs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        timedOut = await Promise.race([
          attempt.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), opts.caseTimeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
      } else {
        await attempt;
      }
      const durationMs = Math.round(performance.now() - start);
      if (timedOut) {
        counts.failed++;
        event = {
          case: name,
          status: "fail",
          provenance: { "limit-exceeded": "case-timeout" },
          detail: `case timeout exceeded (${(opts.caseTimeoutMs! / 1000)}s)`,
          "duration-ms": durationMs,
          "diagnostics-complete": false,
        };
      } else {
        counts.passed++;
        event = {
          case: name,
          status: "pass",
          provenance: "returned",
          "duration-ms": durationMs,
          // The case returned normally, so its diagnostics sideband is
          // complete (upstream emits this on every returned row; deltic's
          // trap/timeout rows already carry `false`).
          "diagnostics-complete": true,
        };
      }
    } catch (e) {
      const durationMs = Math.round(performance.now() - start);
      if (e instanceof WitError) {
        const payload = e.payload as
          | { tag: "failed"; val: string }
          | { tag: "skipped"; val: string }
          | undefined;
        if (payload?.tag === "failed") {
          counts.failed++;
          event = {
            case: name,
            status: "fail",
            provenance: "returned",
            detail: payload.val,
            "duration-ms": durationMs,
            "diagnostics-complete": true,
          };
        } else if (payload?.tag === "skipped") {
          counts.skipped++;
          event = {
            case: name,
            status: "skipped",
            provenance: "returned",
            detail: payload.val,
            "duration-ms": durationMs,
            "diagnostics-complete": true,
          };
        } else {
          // Contract violation: `outcome` has exactly two cases. Treat as
          // this case's failure, same as a trap (the run() promise made a
          // verdict-shaped claim the runner cannot parse).
          counts.failed++;
          event = {
            case: name,
            status: "fail",
            provenance: "trap",
            detail: `run() rejected with an unrecognized outcome payload: ` +
              `${JSON.stringify(payload)}`,
            "duration-ms": durationMs,
            "diagnostics-complete": false,
          };
        }
      } else {
        // Trap (real wasm trap, or any unbranded throw): "a runner treats a
        // trap as this case's failure and the suite instance as poisoned"
        // (wit/tests.wit `test-case.run` doc comment) — poisoning is moot
        // under `freshCases` (the default), since the NEXT case gets a fresh
        // instance regardless.
        counts.failed++;
        const isTrap = e instanceof Trap;
        event = {
          case: name,
          status: "fail",
          provenance: "trap",
          detail: `trap: ${isTrap ? e.message : describeThrow(e)}`,
          "duration-ms": durationMs,
          "diagnostics-complete": false,
        };
      }
    }
    if (diags.length > 0) event.diagnostics = diags;
    opts.emit(JSON.stringify(event));
    opts.log?.(`${name} … ${event.status}`);
  }

  opts.emit('{"segment-end":true}');
  return counts;
}

// deno-lint-ignore no-explicit-any
async function findByName(list: any[], name: string): Promise<any> {
  for (const c of list) {
    if (String(await c.name()) === name) return c;
  }
  return undefined;
}

export { analyzeImports, MissingImportsError, requireImportsResolved } from "./import-analysis.ts";
