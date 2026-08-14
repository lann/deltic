// #18 — polymorph-tls: smoke the jco-leg surface under deltic.
//
//   deno run --allow-read --allow-hrtime run.ts            # translate-only
//   deno run --allow-read run.ts --exec                    # + execute suites
//   deno run --allow-read run.ts --exec --only SUBSTRING
//
// Mirrors tools/smoke-c0 leg 4 (translate-only + import-surface enumeration)
// and then goes one step further than the issue asks: the tls conformance
// suite artifacts are fully composed (no network, no sockets — recon
// 2026-08-09), so the same ct-runner + wasi-shims path that ran the
// websocket suite (the retired ports/websocket conformance runner; the
// consumer's own deltic legs carry it now) can execute them
// directly. All consumer artifacts are referenced by absolute path and are
// READ-ONLY; nothing here writes to the polymorph trees.
//
// Named residues (conformance discipline: no unnamed absorption):
//   TAG-GATING (#25) — FIXED (ct-runner reads the suites' own
//     `component-test:tags@0.1` inventory, ct-runner/src/tags.ts; the
//     sections survive wac composition, verified on these artifacts). Each
//     target below declares its missing-features and the previously
//     xfailed cases schedule out as `not-applicable`, exactly like their
//     harness legs; the xfail entries were pruned.
//   CALLBACK-NULL-CONTEXT (#24) — FIXED (continuation-chunk attribution
//     sentinels, jspi/bridge.ts); the entry below was pruned. The
//     webcrypto-composed target is the only corpus that reaches the
//     interleave, so this suite remains its integration pin
//     (runtime/tests/jspi/chunk_attribution_test.ts is the unit pin).

import {
  fmtSurface,
  loadTranslator,
  planShape,
  POLYMORPH,
  readArtifact,
  sha256Hex,
  translateOnce,
} from "../smoke-c0/common.ts";
import type { ComponentArtifacts } from "../../runtime/src/embedder/mod.ts";
import { runSuite } from "../../ct-runner/src/mod.ts";
import { wasiShims } from "../../wasi-shims/src/mod.ts";

const CONF = `${POLYMORPH}/polymorph-tls/target/conformance`;

/** Everything prebuilt in the consumer tree (recon 2026-08-09). */
const TRANSLATE_TARGETS: Array<[string, string]> = [
  ["suite: plain (tls world, ed25519 only)", `${CONF}/suite-plain.wasm`],
  ["suite: delegated (fixture signer plugged)", `${CONF}/suite-delegated.wasm`],
  [
    "suite: delegated-webcrypto (webcrypto provider plugged)",
    `${CONF}/suite-delegated-webcrypto.wasm`,
  ],
  ["bare: tls-plain (pre-fusion component)", `${CONF}/tls-plain.wasm`],
  ["bare: tls-delegated", `${CONF}/tls-delegated.wasm`],
  ["bare: tls-delegated-unwired (signer import open)", `${CONF}/tls-delegated-unwired.wasm`],
  ["bare: tls-delegated-webcrypto", `${CONF}/tls-delegated-webcrypto.wasm`],
  [
    "provider: webcrypto-signer-with-provider",
    `${CONF}/webcrypto-signer-with-provider.wasm`,
  ],
];

/** The executable smoke matrix: [target-key, artifact, missing-features,
 * xfails]. All compositions are self-contained (surfaces are pure WASI —
 * phase 1), so no extra host modules are wired. `missing` mirrors what
 * their harness legs pass per target (run-node.mjs); tag gating turns the
 * per-target inapplicable cases into `not-applicable` rows. Any future
 * xfail must name its class + issue. */
const EXEC_TARGETS: Array<[string, string, string[], Record<string, string>]> = [
  ["deltic-delegated", `${CONF}/suite-delegated.wasm`, [], {}],
  ["deltic-delegated-webcrypto", `${CONF}/suite-delegated-webcrypto.wasm`, [], {}],
  // Plain composition: no signer is wired, so the signer-gated case
  // schedules out; `delegated/decline` (!delegated-signer) APPLIES here and
  // passes (it asserts exactly the no-signer refusal).
  ["deltic-plain", `${CONF}/suite-plain.wasm`, ["delegated-signer"], {}],
];

const CASE_TIMEOUT_MS = 60_000; // run-node.mjs's per-case wall bound.

async function translatePhase(): Promise<number> {
  console.log("=== #18 polymorph-tls smoke, phase 1: translate-only ===\n");
  let failures = 0;
  const t = await loadTranslator();
  for (const [label, path] of TRANSLATE_TARGETS) {
    console.log(`--- ${label}`);
    console.log(`    ${path}`);
    let bytes: Uint8Array;
    try {
      bytes = await readArtifact(path);
    } catch (e) {
      console.log(`    SKIP — not present: ${e}`);
      continue;
    }
    console.log(`    bytes:  ${bytes.length}`);
    console.log(`    sha256: ${await sha256Hex(bytes)}`);
    const cold = translateOnce(t, bytes);
    const warm: number[] = [];
    for (let i = 0; i < 3; i++) warm.push(translateOnce(t, bytes).ms);
    if (!cold.ok) {
      failures++;
      console.log(`    VERDICT: REJECTED [${cold.errorPhase}]`);
      console.log(`      message: ${cold.errorMessage}`);
      console.log(`      detail:  ${cold.errorDetail}`);
      console.log();
      continue;
    }
    console.log(
      `    VERDICT: ACCEPTED — cold ${cold.ms.toFixed(1)} ms, warm ${
        warm.map((w) => w.toFixed(1)).join("/")
      } ms, envelope ${cold.envelopeBytes} B`,
    );
    console.log(`    ${planShape(cold.plan!)}`);
    console.log(`    IMPORT SURFACE:`);
    console.log(fmtSurface(cold.plan!));
    console.log();
  }
  return failures;
}

async function execPhase(only?: string): Promise<number> {
  console.log("\n=== phase 2: execute the suites (ct-runner + wasi-shims) ===\n");
  const t = await loadTranslator();
  let failures = 0;
  for (const [target, path, missing, xfails] of EXEC_TARGETS) {
    console.log(`--- ${target}: ${path}`);
    let componentBytes: Uint8Array;
    try {
      componentBytes = await readArtifact(path);
    } catch (e) {
      console.log(`    SKIP — not present: ${e}\n`);
      continue;
    }
    const { plan, adapters } = t.translate(componentBytes);
    const artifacts: ComponentArtifacts = { plan, componentBytes, adapters };
    const lines: string[] = [];
    try {
      const counts = await runSuite(artifacts, {
        imports: wasiShims(),
        target,
        suiteName: path.split("/").pop()!.replace(/\.wasm$/, ""),
        missing,
        only,
        caseTimeoutMs: CASE_TIMEOUT_MS,
        emit: (line) => lines.push(line),
        log: (msg) => console.error(`    ${msg}`),
      });
      console.log(
        `    ${counts.passed} passed | ${counts.failed} failed | ` +
          `${counts.skipped} skipped | ${counts.na} n/a (${counts.total} total)`,
      );
      // deltic-plain: delegated-* failures are the KNOWN tag-gating delta
      // (header comment); anything else counts.
      const failed = lines.map((l) => JSON.parse(l)).filter((o) =>
        o.case !== undefined && o.status === "fail"
      );
      let unexpected = 0;
      for (const o of failed) {
        const xf = xfails[o.case as string];
        if (xf !== undefined) {
          console.log(`      XFAIL ${o.case}: ${xf}`);
        } else {
          unexpected++;
          console.log(`      FAIL ${o.case}: ${JSON.stringify(o)}`);
        }
      }
      // Stale-xfail detection, same discipline as the harness: an xfail
      // that PASSES must be pruned, not silently absorbed.
      const failedNames = new Set(failed.map((o) => o.case as string));
      for (const name of Object.keys(xfails)) {
        if (!failedNames.has(name) && (!only || name.includes(only))) {
          unexpected++;
          console.log(`      STALE XFAIL ${name}: now passing — prune`);
        }
      }
      if (unexpected > 0) {
        failures++;
        console.log(`    VERDICT: FAIL`);
      } else {
        console.log(`    VERDICT: PASS (${Object.keys(xfails).length} named xfails)`);
      }
    } catch (e) {
      failures++;
      console.log(`    VERDICT: ERROR — ${e}`);
    }
    console.log();
  }
  return failures;
}

const exec = Deno.args.includes("--exec");
const onlyIdx = Deno.args.indexOf("--only");
const only = onlyIdx >= 0 ? Deno.args[onlyIdx + 1] : undefined;

let failures = await translatePhase();
if (exec) failures += await execPhase(only);
console.log(
  `\nsmoke-tls verdict: ${failures === 0 ? "PASS" : `FAIL (${failures})`}`,
);
if (failures > 0) Deno.exit(1);
