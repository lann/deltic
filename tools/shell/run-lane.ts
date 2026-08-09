// Engine-shell canary lane driver (issue #22).
//
// Deno-lane-shaped: spawns the shell as a child process (`tools/shell/dist/
// entry.js`, bundled by `tools/shell/bundle.ts`), CWD'd to the repo root so
// the entry's disk reads (`harness/generated/**`, the shim, the probe
// modules) resolve without any argv/config plumbing. Parses the entry's
// `@deltic:`-prefixed protocol lines from stdout and classifies with the
// SAME `harness/src/xfail.ts` + `Summary` + per-lane-overlay machinery the
// browser lanes use (`tools/browser/classify.ts` — shared, not forked).
//
//   RUN INSTRUCTIONS
//   ----------------
//   One-time shell fetch (into ./.shell-cache, gitignored):
//
//     deno run -A tools/shell/fetch.ts spidermonkey
//     deno run -A tools/shell/fetch.ts jsc        # x86_64 CI only
//
//   Then:
//
//     deno run -A tools/shell/run-lane.ts spidermonkey [--json <path>]
//     deno run -A tools/shell/run-lane.ts jsc [--json <path>]
//
//   Machinery validation against a LOCAL stable jsc (not jsc-trunk; see
//   `harness/shell/expectations/jsc-trunk.ts`'s header for the recipe that
//   produces a local build from the distro's .deb):
//
//     deno run -A tools/shell/run-lane.ts jsc \
//       --shell-bin /path/to/jsc --lib-path /path/to/libdir
//
//   Prerequisites (checked at startup, same as the browser lane):
//     * `cd harness && deno task gen`        -> harness/generated/**
//     * `cd harness && deno task shim-check` -> the translator shim wasm
//
//   Exit codes — FINDINGS LANE POLICY (issue #22: "findings lanes, never
//   gating"): 0 = ran to completion, deviations (if any) recorded in the
//   report; 2 = infrastructure failure ONLY (shell binary missing, zero
//   files ran, the shell crashed mid-corpus with no results at all). A red
//   diff against the overlay is NOT an infrastructure failure and does not
//   change the exit code — that's what distinguishes "canary lane" from
//   "gate".

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";
import { classify, diffTotals, totalsOf } from "../browser/classify.ts";
import type { ShellLaneExpectation } from "../../harness/shell/expectations/types.ts";
import spidermonkeyNightly from "../../harness/shell/expectations/spidermonkey-nightly.ts";
import jscTrunk from "../../harness/shell/expectations/jsc-trunk.ts";
import { bundle } from "./bundle.ts";
import { defaultShellPaths } from "./fetch.ts";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

const EXPECTATIONS: Record<string, ShellLaneExpectation> = {
  spidermonkey: spidermonkeyNightly,
  jsc: jscTrunk,
};

interface Args {
  lane: string;
  shellBin: string | null;
  libPath: string | null;
  jsonOut: string | null;
}

function parseArgs(argv: string[]): Args {
  const lane = argv.find((a) => !a.startsWith("-")) ?? "spidermonkey";
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  return {
    lane,
    shellBin: get("--shell-bin"),
    libPath: get("--lib-path"),
    jsonOut: get("--json"),
  };
}

function fail(msg: string, code = 2): never {
  console.error(`\n[shell-lane] ${msg}`);
  Deno.exit(code);
}

async function preflight(): Promise<void> {
  const manifest = join(repoRoot, "harness", "generated", "manifest.json");
  try {
    await Deno.stat(manifest);
  } catch {
    fail(`missing ${manifest} — run \`cd harness && deno task gen\` first`);
  }
  const shim = join(
    repoRoot,
    "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  );
  try {
    await Deno.stat(shim);
  } catch {
    fail(`missing ${shim} — run \`cd harness && deno task shim-check\` first`);
  }
}

type ShellFile = {
  path: string;
  dir: string;
  source: string;
  // deno-lint-ignore no-explicit-any
  results: any[];
  ms: number;
};
// deno-lint-ignore no-explicit-any
type Header = any;

/**
 * Runs the bundled entry under the shell binary. SpiderMonkey needs
 * `--module=<path>` (verified: bare positional args after `--module=<path>`
 * are consumed as additional scripts to run, NOT bound as `scriptArgs` — so
 * this driver passes no positional args at all and the entry derives the
 * repo root from `import.meta.url`); JSC accepts `-m <path>` (verified:
 * works even with a non-`.mjs` extension). Neither shell needs
 * `scriptArgs`/`arguments` here — see entry.ts's header.
 *
 * The CWD is set to the repo root but the entry does NOT rely on it: JSC
 * trunk bundles run through their shipped wrapper, which chdir()s into the
 * bundle directory before exec'ing `bin/jsc` (whose PT_INTERP is the
 * *relative* path `lib/ld-linux-x86-64.so.2`) — see fetchJsc in fetch.ts.
 * The wrapper absolutizes relative argv paths against our CWD first, so the
 * bundle path argument works either way.
 */
async function runShell(
  lane: string,
  shellBin: string,
  libPath: string | null,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const bundlePath = join(repoRoot, "tools", "shell", "dist", "entry.js");
  const args = lane === "spidermonkey"
    ? [`--module=${bundlePath}`]
    : ["-m", bundlePath];
  const env: Record<string, string> = {};
  if (libPath) env.LD_LIBRARY_PATH = libPath;
  const cmd = new Deno.Command(shellBin, {
    args,
    cwd: repoRoot,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  let out;
  try {
    out = await cmd.output();
  } catch (e) {
    // Exit-2 policy: a shell that cannot even be spawned is an
    // infrastructure failure, not a lane finding.
    fail(
      `could not spawn ${shellBin}: ${
        e instanceof Error ? e.message : String(e)
      }\n  fetch it first: deno run -A tools/shell/fetch.ts ${lane}`,
    );
  }
  const { code, stdout, stderr } = out;
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

const SENTINEL = "@deltic:";

function parseProtocol(stdout: string): { header: Header; files: ShellFile[] } {
  let header: Header = null;
  const files: ShellFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(SENTINEL)) continue; // shells print their own diagnostics too
    // deno-lint-ignore no-explicit-any
    let obj: any;
    try {
      obj = JSON.parse(line.slice(SENTINEL.length));
    } catch {
      continue; // a truncated/interleaved line; not this driver's problem to fix
    }
    // entry.ts's `emit(kind, payload)` merges `{kind, ...payload}` onto one
    // line — the header event's fields (engine/capabilities/etc) are
    // therefore top-level on the event object itself, not nested under a
    // `header` key (only the `file` event nests its payload, under `file`).
    if (obj.kind === "header") header = obj;
    else if (obj.kind === "file" && obj.file) files.push(obj.file);
  }
  return { header, files };
}

async function main() {
  const args = parseArgs(Deno.args);
  const exp = EXPECTATIONS[args.lane];
  if (!exp) fail(`unknown lane '${args.lane}' (spidermonkey | jsc)`);

  await preflight();

  const defaults = defaultShellPaths(args.lane);
  const shellBin = args.shellBin ?? defaults.bin;
  const libPath = args.libPath ?? defaults.libPath;
  try {
    await Deno.stat(shellBin);
  } catch {
    fail(
      `shell binary not found: ${shellBin}\n` +
        `  fetch it with: deno run -A tools/shell/fetch.ts ${args.lane}\n` +
        `  or pass --shell-bin <path> --lib-path <dir> for a local build`,
    );
  }

  console.log(`[shell-lane] bundling…`);
  await bundle();

  console.log(`[shell-lane] running ${shellBin} …`);
  const wall0 = performance.now();
  const { code, stdout, stderr } = await runShell(args.lane, shellBin, libPath);
  const wallMs = Math.round(performance.now() - wall0);

  const { header, files } = parseProtocol(stdout);

  console.log(`\n=== lane: ${args.lane} ===`);
  console.log(`engine     : ${header?.engine ?? "(none — no header line)"}`);
  console.log(`version    : ${header?.engineVersion ?? "?"}`);
  console.log(`capabilities: ${JSON.stringify(header?.capabilities ?? null)}`);
  console.log(`shim sha256: ${header?.shimBuildHash ?? "?"}`);
  console.log(`files ran  : ${files.length}/${header?.fileCount ?? "?"}`);
  console.log(`wall clock : ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`shell exit : ${code}`);
  console.log(`notes      : ${exp.notes}`);

  if (files.length === 0) {
    console.error(`\nshell stderr (first 4000 chars):\n${stderr.slice(0, 4000)}`);
    console.error(`\nshell stdout (first 2000 chars):\n${stdout.slice(0, 2000)}`);
    fail(`no files ran (shell exit ${code})`);
  }

  const { summary, unexpectedFailures, staleDeltas } = classify(files, exp);
  console.log(`\n${summary.format()}\n`);

  if (args.jsonOut) {
    await Deno.writeTextFile(
      args.jsonOut,
      JSON.stringify({ lane: args.lane, header, wallMs, files }, null, 2),
    );
    console.log(`[shell-lane] raw results -> ${args.jsonOut}`);
  }

  let bad = false;

  if (header && files.length !== header.fileCount) {
    console.error(
      `\nCORPUS SHRANK: ${files.length} of ${header.fileCount} files reported`,
    );
    bad = true;
  }
  if (unexpectedFailures.length > 0) {
    console.error(`\n${unexpectedFailures.length} UNEXPECTED FAILURE(S):`);
    for (const u of unexpectedFailures.slice(0, 60)) {
      console.error(
        `  ${u.file}:${u.line} ${u.type}: ${u.detail.slice(0, 300)}`,
      );
    }
    if (unexpectedFailures.length > 60) {
      console.error(`  … and ${unexpectedFailures.length - 60} more`);
    }
    bad = true;
  }
  if (summary.staleXfails.length > 0) {
    console.error(
      `\n${summary.staleXfails.length} STALE XFAIL(S) on this lane ` +
        `(marked xfail on Deno but PASSING here — an engine delta worth an ` +
        `\`expected-pass\` overlay entry, not an xfail.ts edit):`,
    );
    for (const s of summary.staleXfails.slice(0, 40)) {
      console.error(`  ${s.file}:${s.line}`);
    }
    bad = true;
  }
  if (staleDeltas.length > 0) {
    console.error(`\n${staleDeltas.length} STALE OVERLAY DELTA(S) (predicted, did not occur):`);
    for (const d of staleDeltas) {
      console.error(`  ${d.file}:${d.line} [${d.kind}] ${d.reason}`);
    }
    bad = true;
  }
  if (exp.totals) {
    const diff = diffTotals(totalsOf(summary), exp.totals);
    if (diff.length > 0) {
      console.error(`\nTOTALS DIFFER FROM EXPECTATION:`);
      for (const d of diff) console.error(d);
      bad = true;
    }
  }

  if (!bad) {
    console.log(`\n[shell-lane] ${args.lane}: OK (matches expectation)`);
    Deno.exit(0);
  }
  console.error(
    `\n[shell-lane] ${args.lane}: deviations recorded (findings lane, not gating)`,
  );
  // Findings lanes never gate on deviations — only infrastructure failure
  // (caught above via `fail(...)`, exit 2) does.
  Deno.exit(0);
}

if (import.meta.main) await main();
