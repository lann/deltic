/// <reference lib="dom" />
// In-page conformance runner (M3 browser lane).
//
// This module is bundled to `harness/browser/dist/entry.js` and loaded by
// `index.html`. It is deliberately *dumb*: it executes the same command loop
// the Deno conformance test runs (`harness/src/runner.ts` +
// `RuntimeExecutor`) and streams raw per-command verdicts back to the driver.
// ALL classification (xfail, lane overlays, the per-directory table) stays in
// Deno, in `tools/browser/run-lane.ts`, so the browser lane and the Deno lane
// share one source of truth for expectations.
//
// See `tools/browser/run-lane.ts` for run instructions.
//
// Platform note: the bundle substitutes `harness/browser/shims/async_hooks.ts`
// for the runtime's `node:async_hooks` import (FINDING M3A-1). Read that
// file's header before interpreting any `async/` result on a browser lane.

import type { WastJson } from "../src/schema.ts";
import { RuntimeExecutor } from "../src/runtime-executor.ts";
import { runWastJson } from "../src/runner.ts";

/** Mirrors conformance_test.ts's per-file stall guard. */
const STALL_TIMEOUT_MS = 30_000;

export interface BrowserCommandResult {
  line: number;
  type: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  detail?: string;
}

export interface BrowserFileResult {
  path: string;
  dir: string;
  source: string;
  results: BrowserCommandResult[];
  ms: number;
}

export interface BrowserHeader {
  userAgent: string;
  /** Does this engine expose the JSPI JS API surface at all? */
  jspi: {
    suspending: boolean;
    promising: boolean;
    /** A real end-to-end suspend/resume through a tiny module. */
    roundTrip: boolean | string;
  };
  shimBuildHash: string | null;
  fileCount: number;
}

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
}

/**
 * End-to-end JSPI probe. Feature *presence* (`WebAssembly.Suspending`) is not
 * the same as feature *function*: Firefox ships the constructors behind
 * `javascript.options.wasm_js_promise_integration` and WebKit's availability
 * varies by build, so the lane reports an actual suspend/resume round trip.
 *
 * The module below is hand-assembled: `(module (import "" "f" (func $f
 * (result i32))) (func (export "g") (result i32) (call $f)))`.
 */
async function probeJspi(): Promise<BrowserHeader["jspi"]> {
  // deno-lint-ignore no-explicit-any
  const W = WebAssembly as any;
  const suspending = typeof W.Suspending === "function";
  const promising = typeof W.promising === "function";
  if (!suspending || !promising) {
    return { suspending, promising, roundTrip: false };
  }
  try {
    const bytes = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00, // magic + version
      0x01,
      0x05,
      0x01,
      0x60,
      0x00,
      0x01,
      0x7f, // type: [] -> [i32]
      0x02,
      0x06,
      0x01,
      0x00,
      0x01,
      0x66,
      0x00,
      0x00, // import "" "f" func 0
      0x03,
      0x02,
      0x01,
      0x00, // func 1 : type 0
      0x07,
      0x05,
      0x01,
      0x01,
      0x67,
      0x00,
      0x01, // export "g" func 1
      0x0a,
      0x06,
      0x01,
      0x04,
      0x00,
      0x10,
      0x00,
      0x0b, // code: call 0; end
    ]);
    const { instance } = await WebAssembly.instantiate(bytes.buffer, {
      "": {
        f: new W.Suspending(() =>
          new Promise<number>((r) => setTimeout(() => r(42), 0))
        ),
      },
    });
    const g = W.promising(instance.exports.g);
    const v = await g();
    return { suspending, promising, roundTrip: v === 42 };
  } catch (e) {
    return {
      suspending,
      promising,
      roundTrip: `threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(d)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export interface RunOptions {
  /** Called after each file with its result (used to stream progress). */
  onFile?: (r: BrowserFileResult) => void;
  onHeader?: (h: BrowserHeader) => void;
  /** Triage aid: restrict the run to these corpus-relative paths. */
  only?: string[];
}

export async function runAll(
  opts: RunOptions = {},
): Promise<{ header: BrowserHeader; files: BrowserFileResult[] }> {
  const shimWasm = await fetchBytes("./corpus/translator_shim.wasm");
  const executor = await RuntimeExecutor.create(shimWasm);

  const manifest: { files: string[] } = await (
    await fetch("./corpus/manifest.json")
  ).json();

  const header: BrowserHeader = {
    userAgent: navigator.userAgent,
    jspi: await probeJspi(),
    // `RuntimeExecutor` keeps its Translator private, so digest the bytes we
    // fetched — same definition as `Translator.buildHash` (sha256 hex).
    shimBuildHash: await sha256Hex(shimWasm),
    fileCount:
      (opts.only
        ? manifest.files.filter((f) => opts.only!.includes(f))
        : manifest.files).length,
  };
  opts.onHeader?.(header);

  const files: BrowserFileResult[] = [];
  const wanted = opts.only
    ? manifest.files.filter((f) => opts.only!.includes(f))
    : manifest.files;
  for (const relPath of wanted) {
    const dir = relPath.split("/")[0];
    const t0 = performance.now();
    const doc: WastJson = await (await fetch(`./corpus/${relPath}`)).json();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"stalled">((resolve) => {
      timer = setTimeout(() => resolve("stalled"), STALL_TIMEOUT_MS);
    });
    let raced: Awaited<ReturnType<typeof runWastJson>> | "stalled";
    try {
      raced = await Promise.race([
        runWastJson(
          doc,
          (filename) => fetchBytes(`./corpus/${dir}/${filename}`),
          executor,
        ),
        timeout,
      ]);
    } catch (e) {
      // The Deno lane lets a throw here fail the whole `Deno.test`; in the
      // browser we must keep the corpus complete, so record every command of
      // the file as failed with the throw's message.
      raced = {
        source: doc.source_filename,
        results: doc.commands.map((c) => ({
          line: c.line,
          type: c.type,
          status: "failed" as const,
          detail: `RUNNER THREW: ${
            e instanceof Error ? e.stack ?? e.message : String(e)
          }`,
        })),
      };
    }
    clearTimeout(timer);

    const result = raced === "stalled"
      ? {
        source: doc.source_filename,
        results: doc.commands.map((c) => ({
          line: c.line,
          type: c.type,
          status: "failed" as const,
          detail: `STALLED: file did not complete within ${
            STALL_TIMEOUT_MS / 1000
          }s (a stall is a worse defect than a failure)`,
        })),
      }
      : raced;

    const fileResult: BrowserFileResult = {
      path: relPath,
      dir,
      source: result.source,
      results: result.results as BrowserCommandResult[],
      ms: Math.round(performance.now() - t0),
    };
    files.push(fileResult);
    opts.onFile?.(fileResult);
    // Yield to the event loop so the page stays responsive and any pending
    // engine-driven resumptions from the file just finished get to run before
    // the next file's fresh state.
    await new Promise((r) => setTimeout(r, 0));
  }

  return { header, files };
}

// Driver entry point: `page.evaluate(() => __ceRunAll())`.
//
// Results are ALSO streamed to the server's ingest endpoint file-by-file, so
// that a page crash / OOM mid-corpus leaves the driver with everything that
// ran rather than nothing: `{kind:"header"}`, then one `{kind:"file"}` per
// corpus file, then `{kind:"done"}`.
// deno-lint-ignore no-explicit-any
(globalThis as any).__ceRunAll = async () => {
  const status = document.getElementById("status");
  let done = 0;
  const post = (body: unknown) =>
    fetch("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(() => {});
  const out = await runAll({
    onHeader: (h) => {
      if (status) status.textContent = `jspi=${JSON.stringify(h.jspi)}`;
      void post({ kind: "header", header: h });
    },
    onFile: (f) => {
      done++;
      if (status) {
        status.textContent = `${done} files — last ${f.path} (${f.ms}ms)`;
      }
      void post({ kind: "file", file: f });
    },
  });
  await post({ kind: "done" });
  return out;
};

/** Triage aid: run a subset of the corpus and return the raw results. */
// deno-lint-ignore no-explicit-any
(globalThis as any).__ceRunFiles = (paths: string[]) => runAll({ only: paths });
