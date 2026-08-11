// Builds the shell-lane bundle into `tools/shell/dist/` (gitignored, same as
// `harness/browser/dist/`). Same `deno bundle` mechanics as
// `tools/browser/bundle.ts` (see that file's header) — a separate script
// per issue #22's dispatch, not a shared one, because the entry points and
// output layout differ (no `harness/browser/index.html` to sit next to).
//
// Usage: deno run -A tools/shell/bundle.ts

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

export async function bundle(): Promise<void> {
  const out = join(repoRoot, "tools", "shell", "dist", "entry.js");
  await Deno.mkdir(dirname(out), { recursive: true });
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--platform",
      "browser",
      "--format",
      "esm",
      "--sourcemap=linked",
      "-o",
      out,
      join(repoRoot, "tools", "shell", "entry.ts"),
    ],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`deno bundle failed with code ${code}`);
  // Byte-identical .mjs copy for the node/bun lanes (host-node.mjs imports
  // it): with no package.json anywhere above tools/shell/dist/, node parses
  // a .js file as CommonJS and rejects the bundle's import/export syntax;
  // the .mjs extension forces ESM. (The jsshells keep loading entry.js —
  // one bundle, two names, so every lane runs the same bytes.)
  await Deno.copyFile(out, join(dirname(out), "entry.mjs"));
  return;
}

if (import.meta.main) await bundle();
