// @polyengine/translator — the packaged translator wasm plus its per-platform
// loader (issue #16 delivery design note, item 3).
//
// Why a separate package: the translator is a versioned peer of the
// runtime (plan-format coupling), so it ships inside the same release —
// but embedders that translate at BUILD time (tools/translate,
// embedder-api A4) deploy no translator at all, and keeping the ~1.85 MB
// asset out of @polyengine/runtime keeps their production graphs clean.
//
// The asset (`translator_shim.wasm`, sibling to this module) is copied
// from the cargo build by `just shim` and is gitignored — run `just shim`
// once in a fresh checkout. Publish tooling will pin the exact asset (and
// its digest) into the released package when #16's packaging lands.

import { Translator } from "@polyengine/runtime/shim";

let singleton: Promise<Translator> | undefined;

/**
 * The packaged translator, loaded lazily and cached for the realm.
 *
 * Platform paths, in order of preference:
 *
 *   * **Deno** — native wasm-module import: stable, permission-free, and
 *     delivery/caching ride the module cache. The shim imports nothing,
 *     so the ESM integration instantiates it trivially and
 *     `Translator.fromExports` wraps the namespace with no compile and no
 *     copy. (`buildHash` is unrecoverable from an instance, so the
 *     artifact cache keys without translator identity on this path —
 *     see Translator.buildHash.)
 *   * **Node** — `node:fs` read of the packaged asset (Node's wasm-module
 *     imports are still experimental; don't build on them).
 *   * **Browser / workers** — `fetch` of the packaged asset URL (bundlers
 *     understand the `new URL(…, import.meta.url)` pattern and carry the
 *     asset).
 *
 * Pass the result to `instantiate({ componentBytes, translator })`
 * (embedder-api A3), or call `.translate()` directly.
 */
export function defaultTranslator(): Promise<Translator> {
  return singleton ??= load();
}

async function load(): Promise<Translator> {
  const url = new URL("./translator_shim.wasm", import.meta.url);
  try {
    if (typeof Deno !== "undefined") {
      // String-literal dynamic import: statically analyzable, so the wasm
      // rides the module graph permission-free; still lazy, and non-Deno
      // platforms never evaluate the Deno-only module (see its header).
      const { ns } = await import("./shim_asset_deno.ts");
      return Translator.fromExports(ns);
    }
    const proc = (globalThis as { process?: { versions?: { node?: string } } })
      .process;
    if (proc?.versions?.node) {
      const { readFile } = await import("node:fs/promises");
      return await Translator.create(new Uint8Array(await readFile(url)));
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`fetching the translator asset failed: ${res.status}`);
    }
    return await Translator.create(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    // The overwhelmingly likely in-repo cause is the missing gitignored
    // asset; say so instead of leaking a bare module-resolution error.
    throw new Error(
      `@polyengine/translator: could not load ${url}: ${e}\n` +
        `(in a repo checkout, run \`just shim\` to build and place the asset)`,
      { cause: e },
    );
  }
}
