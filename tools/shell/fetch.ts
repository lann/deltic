// Fetches trunk/nightly engine shells into `.shell-cache/` (gitignored),
// caching by build identity so re-runs don't re-download.
//
// Usage: deno run -A tools/shell/fetch.ts <spidermonkey|jsc>
//
// Extraction: no system `unzip` on the dev box this was written on, and no
// suitable pure-Deno zip reader was available in the JSR registry at the
// time (checked: no `@zip/zip`). Falls back to `python3 -m zipfile` — every
// CI runner and dev box in this repo's matrix ships python3. Swapping in a
// pure-Deno unzip later is a drop-in replacement for `extractZip` below.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);
const cacheRoot = join(repoRoot, ".shell-cache");

export function defaultShellPaths(
  lane: string,
): { bin: string; libPath: string | null } {
  if (lane === "spidermonkey") {
    const dir = join(cacheRoot, "spidermonkey");
    return { bin: join(dir, "js"), libPath: dir };
  }
  if (lane === "jsc") {
    const dir = join(cacheRoot, "jsc");
    return { bin: join(dir, "jsc"), libPath: join(dir, "lib") };
  }
  throw new Error(`unknown lane: ${lane}`);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  const cmd = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      zipPath,
      destDir,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`python3 zipfile extraction failed (${zipPath})`);
}

/** Recursively find a file by name under `root`; returns its containing dir. */
async function findFile(
  root: string,
  name: string,
): Promise<string | null> {
  for await (const entry of Deno.readDir(root)) {
    const p = join(root, entry.name);
    if (entry.isFile && entry.name === name) return root;
    if (entry.isDirectory) {
      const found = await findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

function smArch(): string {
  // SpiderMonkey nightly publishes linux-aarch64 and linux-x86_64 shells.
  return Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
}

async function fetchSpiderMonkey(): Promise<void> {
  const dir = join(cacheRoot, "spidermonkey");
  const binPath = join(dir, "js");
  try {
    await Deno.stat(binPath);
    console.log(`[fetch] spidermonkey already cached at ${binPath}`);
    return;
  } catch {
    // not cached — fetch below
  }
  const arch = smArch();
  const base = "https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central";
  const url = `${base}/jsshell-linux-${arch}.zip`;
  console.log(`[fetch] spidermonkey: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const buildId = res.headers.get("last-modified") ?? "unknown";
  const zipPath = join(cacheRoot, "jsshell.zip");
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
  await extractZip(zipPath, dir);
  await Deno.remove(zipPath);
  await Deno.chmod(binPath, 0o755);
  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `jsshell-linux-${arch}.zip\nLast-Modified: ${buildId}\nfetched: ${
      new Date().toISOString()
    }\n`,
  );
  console.log(`[fetch] spidermonkey ready: ${binPath} (build ${buildId})`);
}

async function fetchJsc(): Promise<void> {
  if (Deno.build.arch !== "x86_64") {
    throw new Error(
      `jsc-built-products only publishes x86_64 trunk builds (issue #22); ` +
        `this host is ${Deno.build.arch}. For local machinery validation on ` +
        `other arches, extract a distro-stable jsc instead and pass ` +
        `--shell-bin/--lib-path to run-lane.ts (see that file's header for ` +
        `the apt-get/dpkg-deb recipe).`,
    );
  }
  const dir = join(cacheRoot, "jsc");
  const binPath = join(dir, "jsc");
  try {
    await Deno.stat(binPath);
    console.log(`[fetch] jsc already cached at ${binPath}`);
    return;
  } catch {
    // not cached — fetch below
  }
  const base = "https://webkitgtk.org/jsc-built-products/x86_64/release";
  const lastIs = (await (await fetch(`${base}/LAST-IS`)).text()).trim();
  console.log(`[fetch] jsc: LAST-IS = ${lastIs}`);
  const url = `${base}/${lastIs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const zipPath = join(cacheRoot, "jsc.zip");
  const extractedRoot = join(cacheRoot, "jsc-extracted");
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
  await extractZip(zipPath, extractedRoot);
  await Deno.remove(zipPath);

  // Layout unknown ahead of time (never executed anywhere per issue #22) —
  // find the `jsc` executable and infer its lib directory by searching for
  // libJavaScriptCore alongside it.
  const jscDir = await findFile(extractedRoot, "jsc");
  if (!jscDir) {
    throw new Error(
      `could not find a 'jsc' executable anywhere under ${extractedRoot} ` +
        `— zip layout changed; inspect it manually`,
    );
  }
  console.log(`[fetch] found jsc executable in ${jscDir}`);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.copyFile(join(jscDir, "jsc"), binPath);
  await Deno.chmod(binPath, 0o755);

  // Search the whole extracted tree for JavaScriptCore shared libs; copy
  // every directory that has one into dir/lib so LD_LIBRARY_PATH is a
  // single flat answer.
  const libDir = join(dir, "lib");
  await Deno.mkdir(libDir, { recursive: true });
  let foundLibs = false;
  async function walk(d: string) {
    for await (const entry of Deno.readDir(d)) {
      const p = join(d, entry.name);
      if (entry.isDirectory) await walk(p);
      else if (/libjavascriptcore|libwebkit|libwtf|libbmalloc/i.test(entry.name)) {
        await Deno.copyFile(p, join(libDir, entry.name));
        foundLibs = true;
      }
    }
  }
  await walk(extractedRoot);
  if (!foundLibs) {
    console.warn(
      `[fetch] WARNING: no JavaScriptCore/WTF/bmalloc shared libs found under ` +
        `${extractedRoot} — jsc may fail to start; inspect the archive layout`,
    );
  }
  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `LAST-IS: ${lastIs}\nfetched: ${new Date().toISOString()}\n`,
  );
  console.log(`[fetch] jsc ready: ${binPath} (rev ${lastIs}), libs -> ${libDir}`);
}

async function main() {
  const lane = Deno.args[0];
  if (lane === "spidermonkey") await fetchSpiderMonkey();
  else if (lane === "jsc") await fetchJsc();
  else {
    console.error(`usage: deno run -A tools/shell/fetch.ts <spidermonkey|jsc>`);
    Deno.exit(2);
  }
}

if (import.meta.main) await main();
