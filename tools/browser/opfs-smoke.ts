// ============================================================================
// OPFS smoke driver: @deltic/wasi/filesystem-web against the REAL Origin
// Private File System, in a real browser.
//
//   deno run -A tools/browser/opfs-smoke.ts chromium [--headed] [--keep-open]
//   deno run -A tools/browser/opfs-smoke.ts firefox
//
// (Recipe: `just smoke-opfs <lane>`; both lanes ride `just browsers` and
// the post-merge browser CI job.)
//
// What it does: bundles `harness/browser/opfs_entry.ts`, starts the lane's
// static server (which also serves /opfs.html and the wasip2 fixture
// corpus under /fixtures/), launches the browser (shared launcher —
// Firefox gets the JSPI pref), calls the in-page `__opfsSmoke()`, and
// asserts every check passed. Two halves (see opfs_entry.ts): the direct
// descriptor battery (no wasm) and the composed fs-probe guest (std::fs
// through wasi-libc, parking through the A14 marks — JSPI required, so
// this is also the browser exercise of the suspending kernel over real
// async storage).
//
// Prerequisites: `just shim` (the translator shim wasm) and
// `just fixtures` (examples/guests/build/fs-probe.component.wasm) — both
// also checked at startup.
//
// Exit codes: 0 = every check passed; 1 = a check failed; 2 =
// infrastructure failure (no browser, missing fixture, page crash).
// ============================================================================

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";
import { bundle } from "./bundle.ts";
import { launch } from "./launch.ts";
import { startServer } from "./serve.ts";
import type { OpfsSmokeReport } from "../../harness/browser/opfs_entry.ts";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

const SMOKE_TIMEOUT_MS = 120_000;

function fail(msg: string, code = 2): never {
  console.error(`\n[opfs-smoke] ${msg}`);
  Deno.exit(code);
}

async function preflight(): Promise<void> {
  for (
    const [rel, hint] of [
      ["target/wasm32-unknown-unknown/release/translator_shim.wasm", "just shim"],
      ["examples/guests/build/fs-probe.component.wasm", "just fixtures"],
    ] as const
  ) {
    try {
      await Deno.stat(join(repoRoot, rel));
    } catch {
      fail(`missing ${rel} — run \`${hint}\` first`);
    }
  }
}

async function main(): Promise<void> {
  const lane = Deno.args.find((a) => !a.startsWith("-")) ?? "chromium";
  const headed = Deno.args.includes("--headed");
  const keepOpen = Deno.args.includes("--keep-open");

  await preflight();
  console.log(`[opfs-smoke] bundling opfs_entry…`);
  await bundle(
    join("harness", "browser", "opfs_entry.ts"),
    join("harness", "browser", "dist", "opfs_entry.js"),
  );

  const server = startServer(() => {/* the smoke posts nothing */});
  const { browser } = await launch(lane, headed).catch((e) =>
    fail(e instanceof Error ? e.message : String(e))
  );
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => console.error(`[page error] ${e.message}`));
    await page.goto(`${server.origin}/opfs.html`, { waitUntil: "load" });
    await page.waitForFunction("globalThis.__opfsReady === true", null, {
      timeout: 30_000,
    });

    const report = await page.evaluate(
      // In-page: serialize bigints defensively (none cross today).
      `globalThis.__opfsSmoke().then((r) => JSON.parse(JSON.stringify(r)))`,
      { timeout: SMOKE_TIMEOUT_MS },
    ) as OpfsSmokeReport;

    console.log(`\n[opfs-smoke] ${lane}: ${report.userAgent}`);
    console.log(`[opfs-smoke] rename path: ${report.renamePath}`);
    let failed = 0;
    for (
      const [half, checks] of [
        ["direct", report.direct],
        ["composed", report.composed],
      ] as const
    ) {
      for (const check of checks) {
        console.log(`  ${check.ok ? "ok  " : "FAIL"} [${half}] ${check.name}`);
        if (!check.ok) {
          failed++;
          console.log(`       ${check.detail ?? "(no detail)"}`);
        }
      }
    }
    if (report.direct.length === 0) fail("the direct battery reported nothing", 1);
    if (report.composed.length === 0) fail("the composed battery reported nothing", 1);
    if (keepOpen) {
      console.log("[opfs-smoke] --keep-open: waiting (ctrl-c to exit)…");
      await new Promise(() => {});
    }
    if (failed > 0) fail(`${failed} check(s) failed on ${lane}`, 1);
    console.log(`[opfs-smoke] ${lane}: all checks passed`);
  } finally {
    await browser.close();
    await server.shutdown();
  }
}

if (import.meta.main) {
  await main();
}
