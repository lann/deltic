#!/usr/bin/env -S deno run -A
// ct-runner CLI entry.
//
//   deno run -A ct-runner/src/main.ts <suite.wasm> --out results.jsonl \
//     [--imports <module.ts>] [--target NAME] [--suite-name NAME] \
//     [--only SUBSTRING] [--case-timeout-ms N] [--no-fresh-cases] [--jspi]
//
// `--imports <module.ts>` convention (contracts/embedder-api.md §"Module
// wiring and instantiation"): a TS module whose default export is either
// the imports record directly, or a factory (sync or async) producing one.
// Never test-context — the runner supplies that itself.

import { Translator } from "../../runtime/src/shim/mod.ts";
import type { ComponentArtifacts } from "../../runtime/src/embedder/mod.ts";
import { MissingImportsError, runSuite } from "./mod.ts";

const REPO_ROOT = new URL("../../", import.meta.url);

function usageError(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(
    "usage: deno run -A ct-runner/src/main.ts <suite.wasm> --out <results.jsonl> " +
      "[--imports <module.ts>] [--target NAME] [--suite-name NAME] " +
      "[--only SUBSTRING] [--case-timeout-ms N] [--no-fresh-cases] [--jspi]",
  );
  Deno.exit(2);
}

interface Cli {
  suitePath: string;
  out: string;
  importsModule?: string;
  target: string;
  suiteName?: string;
  only?: string;
  caseTimeoutMs?: number;
  freshCases: boolean;
  jspi: boolean;
}

function parseArgs(argv: string[]): Cli {
  const positional: string[] = [];
  let out: string | undefined;
  let importsModule: string | undefined;
  let target = "component-engine/host";
  let suiteName: string | undefined;
  let only: string | undefined;
  let caseTimeoutMs: number | undefined;
  let freshCases = true;
  let jspi = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out":
        out = argv[++i];
        break;
      case "--imports":
        importsModule = argv[++i];
        break;
      case "--target":
        target = argv[++i];
        break;
      case "--suite-name":
        suiteName = argv[++i];
        break;
      case "--only":
        only = argv[++i];
        break;
      case "--case-timeout-ms":
        caseTimeoutMs = Number(argv[++i]);
        break;
      case "--no-fresh-cases":
        freshCases = false;
        break;
      case "--jspi":
        jspi = true;
        break;
      default:
        if (a.startsWith("--")) usageError(`unknown flag '${a}'`);
        positional.push(a);
    }
  }
  if (positional.length !== 1) usageError("expected exactly one <suite.wasm> argument");
  if (out === undefined) usageError("--out <results.jsonl> is required");
  return {
    suitePath: positional[0],
    out,
    importsModule,
    target,
    suiteName,
    only,
    caseTimeoutMs,
    freshCases,
    jspi,
  };
}

async function loadImportsModule(path: string): Promise<Record<string, unknown>> {
  const mod = await import(
    path.startsWith(".") || path.startsWith("/")
      ? new URL(path, `file://${Deno.cwd()}/`).href
      : path
  );
  const def = mod.default;
  if (typeof def === "function") {
    return (await def()) ?? {};
  }
  return (def ?? {}) as Record<string, unknown>;
}

async function loadTranslator(): Promise<Translator> {
  const rel = "target/wasm32-unknown-unknown/release/translator_shim.wasm";
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(new URL(rel, REPO_ROOT));
  } catch {
    console.error(
      `error: missing ${rel} — run: cargo build -p translator-shim --release ` +
        `--target wasm32-unknown-unknown`,
    );
    Deno.exit(1);
  }
  return await Translator.create(bytes);
}

function suiteNameFrom(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.component\.wasm$|\.wasm$/, "");
}

async function main() {
  const cli = parseArgs(Deno.args);
  const componentBytes = await Deno.readFile(cli.suitePath);
  const translator = await loadTranslator();
  const { plan, adapters } = translator.translate(componentBytes);
  const artifacts: ComponentArtifacts = { plan, componentBytes, adapters };

  const imports = cli.importsModule
    ? await loadImportsModule(cli.importsModule)
    : {};

  const lines: string[] = [];
  try {
    const counts = await runSuite(artifacts, {
      imports,
      target: cli.target,
      suiteName: cli.suiteName ?? suiteNameFrom(cli.suitePath),
      only: cli.only,
      caseTimeoutMs: cli.caseTimeoutMs,
      freshCases: cli.freshCases,
      jspi: cli.jspi,
      emit: (line) => lines.push(line),
      log: (msg) => console.error(msg),
    });
    await Deno.writeTextFile(cli.out, lines.join("\n") + "\n");
    console.error(
      `${counts.passed} passed | ${counts.failed} failed | ${counts.skipped} skipped ` +
        `(${counts.total} total) -> ${cli.out}`,
    );
    if (counts.failed > 0) Deno.exit(1);
  } catch (e) {
    if (e instanceof MissingImportsError) {
      console.error(`error: ${e.message}`);
      for (const leaf of e.leaves) console.error(`  - ${leaf.interfaceId}`);
      Deno.exit(3);
    }
    throw e;
  }
}

if (import.meta.main) await main();
