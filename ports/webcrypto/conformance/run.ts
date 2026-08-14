// The flagship gate: execute the consumer's REAL conformance suites
// (`polymorph-webcrypto/conformance/guest-ct` and its signing sibling)
// under deltic, with this port supplying every `polymorph:webcrypto/*`
// interface and `wasi` supplying WASI.
//
//   deno task conformance [--only SUBSTRING] [--suite shared|signing] [--jspi]
//
// Shape follows ports/websocket/conformance/run.ts and
// tools/smoke-tls/run.ts. Two suites, two envelope targets:
//
//   suite    | wasm                              | target key      | missing
//   ---------+-----------------------------------+-----------------+----------------
//   shared   | conformance_guest_ct              | deltic          | ["sha1-checked"]
//   signing  | conformance_signing_guest_ct      | deltic-signing  | (see below)
//
// `missing` is the feature-tag scheduling list (ct-runner's `missing`,
// upstream harness.mjs's): the features THIS target lacks, so cases gated
// on them are scheduled out as `not-applicable` instead of failing.
// `sha1-checked` is the one standing entry — no platform-backed provider
// can serve it (src/sha1Checked.ts) — and the suite's `!sha1-checked`
// decline case still runs, asserting the refusal works.
//
// NOTHING here writes into the consumer tree: it only reads the prebuilt
// suite artifacts, and results are written under this directory.

import { Translator } from "../../../runtime/src/shim/mod.ts";
import type { ComponentArtifacts } from "../../../runtime/src/embedder/mod.ts";
import { runSuite } from "../../../ct-runner/src/mod.ts";
import { wasi } from "../../../wasi/src/mod.ts";
import { setRsaPrivateKeyPolicy, webcryptoImports } from "../src/mod.ts";

const CE_ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = "/home/lmartin/p/polymorph/polymorph-webcrypto";
const SUITE_DIR = `${CONSUMER}/target/wasm32-wasip2/release`;

/** harness.mjs:33's per-case wall bound. */
const CASE_TIMEOUT_MS = 60_000;

interface SuiteSpec {
  /** The lock identity: the wasm file stem (ct-runner normalizes `-` to `_`). */
  name: string;
  wasm: string;
  target: string;
  missing: string[];
}

const SUITES: Readonly<Record<string, SuiteSpec>> = {
  shared: {
    name: "conformance-guest-ct",
    wasm: `${SUITE_DIR}/conformance_guest_ct.wasm`,
    target: "deltic",
    // No platform WebCrypto carries sha1dc; the port declines the
    // interface fail-closed (src/sha1Checked.ts).
    missing: ["sha1-checked"],
  },
  signing: {
    name: "conformance-signing-guest-ct",
    wasm: `${SUITE_DIR}/conformance_signing_guest_ct.wasm`,
    target: "deltic-signing",
    // Deno's `crypto.subtle` serves the gated RSA private-key mints, so
    // this port serves them too (see src/rsaSignature.ts's posture note):
    // nothing is declared missing here.
    missing: [],
  },
};

interface Cli {
  /**
   * `--rsa-private decline`: take the reference's BROWSER posture — the
   * gated RSA private-key interfaces (`rsa-pss-sign`,
   * `rsassa-pkcs1-v15-sign`, `rsa-oaep-decrypt`) refuse with
   * `error.unsupported` — and declare the two matching features missing,
   * so the suite schedules their cases out and runs the `!rsa-sign` /
   * `!rsa-oaep-decrypt` decline cases instead. Default is `serve`
   * (src/rsaSignature.ts's posture note).
   */
  rsaPrivate: "serve" | "decline";
  only?: string;
  jspi: boolean;
  out?: string;
  suites: string[];
  missing?: string[];
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { jspi: false, suites: [], rsaPrivate: "serve" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--only":
        cli.only = argv[++i];
        break;
      case "--jspi":
        cli.jspi = true;
        break;
      case "--out":
        cli.out = argv[++i];
        break;
      case "--suite":
        cli.suites.push(argv[++i]);
        break;
      case "--rsa-private": {
        const value = argv[++i];
        if (value !== "serve" && value !== "decline") {
          throw new Error(`--rsa-private takes "serve" or "decline", got ${value}`);
        }
        cli.rsaPrivate = value;
        break;
      }
      case "--missing":
        cli.missing = argv[++i].split(",").filter((s) => s.length > 0);
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (cli.suites.length === 0) cli.suites = ["shared", "signing"];
  for (const s of cli.suites) {
    if (!(s in SUITES)) throw new Error(`unknown suite '${s}' (known: ${Object.keys(SUITES).join(", ")})`);
  }
  return cli;
}

async function loadArtifacts(wasm: string): Promise<ComponentArtifacts> {
  const shim = `${CE_ROOT}target/wasm32-unknown-unknown/release/translator_shim.wasm`;
  const translator = await Translator.create(await Deno.readFile(shim));
  const componentBytes = await Deno.readFile(wasm);
  const { plan, adapters } = translator.translate(componentBytes);
  return { plan, componentBytes, adapters };
}

async function runOne(spec: SuiteSpec, cli: Cli): Promise<number> {
  const artifacts = await loadArtifacts(spec.wasm);
  const imports = { ...wasi({ cli: { env: {}, passthrough: false } }), ...webcryptoImports() };
  const out = cli.out ?? new URL(`./results-${spec.target}.jsonl`, import.meta.url).pathname;
  const lines: string[] = [];
  const started = performance.now();
  const counts = await runSuite(artifacts, {
    imports,
    target: spec.target,
    suiteName: spec.name,
    only: cli.only,
    missing: cli.missing ??
      (cli.rsaPrivate === "decline"
        ? [...spec.missing, "rsa-sign", "rsa-oaep-decrypt"]
        : spec.missing),
    caseTimeoutMs: CASE_TIMEOUT_MS,
    jspi: cli.jspi,
    emit: (line) => lines.push(line),
    log: (msg) => console.error(msg),
  });
  await Deno.writeTextFile(out, lines.join("\n") + "\n");
  console.error(
    `\n[${spec.target}] ${counts.passed} passed | ${counts.failed} failed | ${counts.skipped} skipped | ` +
      `${counts.na} n/a (${counts.total} total) in ${((performance.now() - started) / 1000).toFixed(1)}s -> ${out}`,
  );
  return counts.failed;
}

async function main() {
  const cli = parseArgs(Deno.args);
  setRsaPrivateKeyPolicy(cli.rsaPrivate);
  let failed = 0;
  for (const key of cli.suites) failed += await runOne(SUITES[key], cli);
  if (failed > 0) Deno.exitCode = 1;
}

if (import.meta.main) await main();
