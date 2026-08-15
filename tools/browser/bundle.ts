// Builds the browser-lane bundle into `harness/browser/dist/` (gitignored).
//
// Bundler: `deno bundle --platform browser` (Deno 2.9.5 ships it as an
// experimental esbuild-backed bundler; it resolves the workspace's
// `@deltic/*` bare specifiers natively, so no alias plumbing is
// needed). The runtime is platform-neutral by contract (docs/architecture.md §4.3) — a
// `node:` specifier appearing in the bundle graph means a regression; the
// M3A-1 episode (scheduler ambient on `node:async_hooks`, fixed by explicit
// ambient threading) is pinned by runtime/tests/platform_purity_test.ts.
//
// Usage: deno run -A tools/browser/bundle.ts

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

export async function bundle(
  entry = join("harness", "browser", "entry.ts"),
  outFile = join("harness", "browser", "dist", "entry.js"),
): Promise<void> {
  const out = join(repoRoot, outFile);
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
      join(repoRoot, entry),
    ],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`deno bundle failed with code ${code}`);
}

if (import.meta.main) await bundle();
