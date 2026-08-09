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
    // `<dir>/jsc` is the bundle's own compiled wrapper (NOT the real
    // binary, which sits at `<dir>/bin/jsc` with a relative PT_INTERP) —
    // see fetchJsc below. No LD_LIBRARY_PATH: the wrapper sets its own,
    // overwriting anything we pass.
    return { bin: join(dir, "jsc"), libPath: null };
  }
  throw new Error(`unknown lane: ${lane}`);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  // Two things extractall() gets wrong that this loop fixes (both
  // load-bearing for the JSC bundle; SpiderMonkey's zip has neither):
  //   * file modes are dropped — reapplied from each entry's external_attr
  //     (the wrapper and bin/jsc must be executable);
  //   * SYMLINK entries are written as tiny regular files containing the
  //     target path — the bundle's lib/ *.so.N names are symlinks to the
  //     real *.so.N.x.y files, and the dynamic linker fails on the fake
  //     ones with "file too short" (this lane's second CI failure).
  const cmd = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys, os, stat, zipfile\n" +
      "z = zipfile.ZipFile(sys.argv[1])\n" +
      "dest = sys.argv[2]\n" +
      "for i in z.infolist():\n" +
      "    mode = i.external_attr >> 16\n" +
      "    p = os.path.join(dest, i.filename)\n" +
      "    if stat.S_ISLNK(mode):\n" +
      "        os.makedirs(os.path.dirname(p), exist_ok=True)\n" +
      "        if os.path.lexists(p): os.remove(p)\n" +
      "        os.symlink(z.read(i).decode(), p)\n" +
      "        continue\n" +
      "    z.extract(i, dest)\n" +
      "    m = mode & 0o7777\n" +
      "    if m and not i.is_dir(): os.chmod(p, m)\n",
      zipPath,
      destDir,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`python3 zipfile extraction failed (${zipPath})`);
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
  await Deno.mkdir(cacheRoot, { recursive: true });
  await Deno.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
  // The archive is a SELF-CONTAINED bundle (built on the WebKit buildbots'
  // OS, newer than any runner) and must be kept intact and executed via its
  // own top-level `jsc` WRAPPER — a compiled C program (source ships as
  // jsc.c in the bundle) that chdir()s into the bundle directory, sets
  // LD_LIBRARY_PATH to the bundled `lib/` (which includes its own
  // ld-linux-x86-64.so.2 and ICU), and exec()s `bin/jsc`. The real binary
  // is NOT relocatable: its PT_INTERP is the *relative* path
  // `lib/ld-linux-x86-64.so.2` (verified with readelf), so executing it
  // outside the bundle root fails with ENOENT — the exact failure of this
  // lane's first CI run. The bundle's README.txt says the same in prose.
  // The wrapper absolutizes relative argv paths against the caller's CWD
  // before the chdir, so callers may pass paths freely.
  await extractZip(zipPath, dir);
  await Deno.remove(zipPath);

  // Layout sanity check — loud if upstream's generate-bundle output changes.
  for (const p of ["jsc", "bin/jsc", "lib/ld-linux-x86-64.so.2"]) {
    try {
      await Deno.stat(join(dir, p));
    } catch {
      throw new Error(
        `jsc bundle layout changed: expected '${p}' under ${dir} — read ` +
          `${join(dir, "README.txt")} (shipped in the bundle) and update ` +
          `fetchJsc to match`,
      );
    }
  }
  // Belt and braces on top of extractZip's mode restoration.
  await Deno.chmod(binPath, 0o755);
  await Deno.chmod(join(dir, "bin", "jsc"), 0o755);

  await Deno.writeTextFile(
    join(dir, "BUILD_IDENTITY"),
    `LAST-IS: ${lastIs}\nfetched: ${new Date().toISOString()}\n`,
  );
  console.log(
    `[fetch] jsc ready: ${binPath} (rev ${lastIs}; self-contained bundle, ` +
      `executed via its wrapper — details in ${join(dir, "README.txt")})`,
  );
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
