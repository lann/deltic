// Shared playwright launcher for the browser lanes (run-lane.ts, the
// OPFS smoke) — one source of truth for the JSPI knobs.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

/**
 * Firefox ships JSPI behind a pref. Playwright's Firefox honours
 * `firefoxUserPrefs` at launch, which is the documented path for
 * `javascript.options.*` knobs.
 */
export const FIREFOX_PREFS: Record<string, unknown> = {
  "javascript.options.wasm_js_promise_integration": true,
  // JSPI's implementation is gated on the exception-handling proposal in
  // SpiderMonkey; set it explicitly so a default flip cannot silently
  // disable the lane's whole point.
  "javascript.options.wasm_exceptions": true,
};

/**
 * Launch a lane browser. Throws (with an install hint) when the download
 * is missing; callers decide the exit-code policy.
 */
export async function launch(
  lane: string,
  headed: boolean,
  // deno-lint-ignore no-explicit-any
): Promise<{ browser: any; name: string }> {
  // `PLAYWRIGHT_BROWSERS_PATH` defaults to the in-repo cache so a bare
  // `deno run -A tools/browser/…` finds the download made by
  // `just browsers-install`.
  if (!Deno.env.get("PLAYWRIGHT_BROWSERS_PATH")) {
    Deno.env.set("PLAYWRIGHT_BROWSERS_PATH", join(repoRoot, ".browser-cache"));
  }
  const pw = await import("npm:playwright@1.62.1");
  const launcher = (pw as unknown as Record<string, {
    // deno-lint-ignore no-explicit-any
    launch(opts: any): Promise<any>;
  }>)[lane];
  if (!launcher) {
    throw new Error(`unknown lane '${lane}' (chromium | firefox | webkit)`);
  }

  // deno-lint-ignore no-explicit-any
  const opts: any = { headless: !headed };
  // Pass the driver's environment through explicitly: playwright does not
  // forward ours by default under Deno's npm compat, and the WebKit lane on a
  // non-Ubuntu-24.04 host needs `LD_LIBRARY_PATH` to reach the browser
  // process (see the WebKit note in harness/browser/expectations/webkit.ts).
  opts.env = Deno.env.toObject();
  if (lane === "firefox") opts.firefoxUserPrefs = FIREFOX_PREFS;
  if (lane === "chromium") {
    // Belt and braces: JSPI is default-on from Chrome 137, but the flag is
    // harmless on newer builds and rescues an older cached download.
    opts.args = ["--enable-experimental-webassembly-jspi"];
  }
  try {
    const browser = await launcher.launch(opts);
    return { browser, name: lane };
  } catch (e) {
    throw new Error(
      `could not launch ${lane}: ${e instanceof Error ? e.message : String(e)}\n` +
        `  install it with: PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache ` +
        `deno run -A npm:playwright@1.62.1 install ${lane}`,
    );
  }
}
