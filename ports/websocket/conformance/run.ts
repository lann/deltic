// The flagship gate: execute the consumer's REAL conformance suite
// (`polymorph-websocket/conformance/guest-ct`) under component-engine, with
// this port supplying `polymorph:websocket/connections@0.1.0` and
// `wasi-shims` supplying WASI.
//
//   deno task conformance [--only SUBSTRING] [--jspi]
//
// `DENO_CERT` must name the suite's committed test CA so the three
// `websocket/tls/*` cases can complete their handshake; `deno task
// conformance` supplies it. NO cases are excluded: the TLS leg runs
// headlessly under Deno exactly as the ws: leg does.
//
// This is the component-engine analogue of the consumer's own jco Node leg,
// `conformance/driver-ct/jco/run-node.mjs`, and mirrors it exactly:
//
//   run-node.mjs                              | this runner
//   ------------------------------------------+---------------------------
//   `connections.setMaxInboundBufferBytes(…)`  | `configure({ … })`, same values
//   `spawnEchod(bin)` scraping LISTENING       | `spawnEchod()`, same scrape
//   `unreachableUrl()` (bind port 0, release)  | same
//   `env = [[WS_CONFORMANCE_*, …]]`            | `wasiShims({ cli: { env } })`
//   `runSuite(...)` (component-test-js)        | `runSuite(...)` (ct-runner)
//   `NODE_EXTRA_CA_CERTS=…/tls/ca.pem`         | `DENO_CERT=…/tls/ca.pem`
//
// NOTHING here writes into the consumer tree: the echod build redirects
// `CARGO_TARGET_DIR`, and results are written under this directory.

import { Translator } from "../../../runtime/src/shim/mod.ts";
import type { ComponentArtifacts } from "../../../runtime/src/embedder/mod.ts";
import { runSuite } from "../../../ct-runner/src/mod.ts";
import { wasiShims } from "../../../wasi-shims/src/mod.ts";
import { configure, websocketImports } from "../src/websocket.ts";

const CE_ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = "/home/lmartin/p/polymorph/polymorph-websocket";
const ECHOD_TARGET = "/tmp/opencode/c3-ws-target";
const ECHOD_BIN = `${ECHOD_TARGET}/debug/conformance-echod`;
/** The suite artifact: the BARE suite — websocket still imported. This is
 * the exact component the jco leg transpiles (jco/package.json's
 * `transpile` script names it), i.e. the pre-transpile input; the sibling
 * `composed/` artifact has the provider plugged in-guest and would exercise
 * no host module at all. */
const SUITE_WASM =
  `${CONSUMER}/target/wasm32-wasip2/release/conformance_guest_ct.wasm`;
const CA_PEM = `${CONSUMER}/conformance/server/tls/ca.pem`;

// The suite bounds, matching run-node.mjs:29-32 (which in turn matches the
// wasmtime leg). Connections capture them at connect, so configuring the
// module once covers every case.
const MAX_INBOUND_BUFFER_BYTES = 256 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 3000;

/** harness.mjs:33's per-case wall bound. */
const CASE_TIMEOUT_MS = 60_000;

interface Cli {
  only?: string;
  jspi: boolean;
  out: string;
  target: string;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    jspi: false,
    out: new URL("./results.jsonl", import.meta.url).pathname,
    target: "component-engine",
  };
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
      case "--target":
        cli.target = argv[++i];
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return cli;
}

/** `spawnEchod` (conformance/server/echod.mjs:13), ported: start the binary
 *  and scrape its one `LISTENING <ws> <wss>` line. */
async function spawnEchod(): Promise<{
  base: string;
  tlsBase: string;
  shutdown: () => void;
}> {
  const child = new Deno.Command(ECHOD_BIN, {
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = setTimeout(() => {
    throw new Error("echo server did not report a URL in time");
  }, 10_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("echo server exited before reporting a URL");
      buffer += decoder.decode(value, { stream: true });
      const m = /LISTENING (ws:\/\/\S+) (wss:\/\/\S+)/.exec(buffer);
      if (m) {
        return {
          base: m[1].trim(),
          tlsBase: m[2].trim(),
          shutdown: () => {
            try {
              child.kill("SIGTERM");
            } catch { /* already gone */ }
            reader.cancel().catch(() => {});
          },
        };
      }
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
}

/** `unreachableUrl` (echod.mjs:53), ported: a loopback `ws:` URL whose
 *  connect attempt should be refused — a port just bound and released. */
function unreachableUrl(): string {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return `ws://127.0.0.1:${port}/echo`;
}

async function ensureEchod(): Promise<void> {
  try {
    const st = await Deno.stat(ECHOD_BIN);
    if (st.isFile) return;
  } catch { /* build it */ }
  console.error(`building conformance-echod into ${ECHOD_TARGET} …`);
  const out = await new Deno.Command("cargo", {
    args: [
      "build",
      "--locked",
      "--manifest-path",
      `${CONSUMER}/Cargo.toml`,
      "-p",
      "conformance-echod",
    ],
    env: { CARGO_TARGET_DIR: ECHOD_TARGET },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!out.success) throw new Error("conformance-echod build failed");
}

async function loadArtifacts(): Promise<ComponentArtifacts> {
  const shim = `${CE_ROOT}target/wasm32-unknown-unknown/release/translator_shim.wasm`;
  const translator = await Translator.create(await Deno.readFile(shim));
  const componentBytes = await Deno.readFile(SUITE_WASM);
  const { plan, adapters } = translator.translate(componentBytes);
  return { plan, componentBytes, adapters };
}

async function main() {
  const cli = parseArgs(Deno.args);

  if (Deno.env.get("DENO_CERT") === undefined) {
    console.error(
      `warning: DENO_CERT is unset — the suite's committed test PKI is not ` +
        `trusted, so the three websocket/tls/* cases will fail their ` +
        `connect. Re-run with DENO_CERT=${CA_PEM} (the Deno analogue of ` +
        `run-node.mjs's NODE_EXTRA_CA_CERTS, justfile:135).`,
    );
  }

  configure({
    maxInboundBufferBytes: MAX_INBOUND_BUFFER_BYTES,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
  });

  await ensureEchod();
  const echod = await spawnEchod();
  console.error(`echo server ready at ${echod.base} (tls: ${echod.tlsBase})`);

  const env: Record<string, string> = {
    WS_CONFORMANCE_SERVER_URL: echod.base,
    WS_CONFORMANCE_TLS_SERVER_URL: echod.tlsBase,
    WS_CONFORMANCE_UNREACHABLE_URL: unreachableUrl(),
    WS_CONFORMANCE_MAX_INBOUND_BUFFER_BYTES: String(MAX_INBOUND_BUFFER_BYTES),
  };

  const artifacts = await loadArtifacts();
  const imports = {
    ...wasiShims({ cli: { env, passthrough: false } }),
    ...websocketImports(),
  };

  const lines: string[] = [];
  const started = performance.now();
  try {
    const counts = await runSuite(artifacts, {
      imports,
      target: cli.target,
      suiteName: "conformance_guest_ct",
      only: cli.only,
      caseTimeoutMs: CASE_TIMEOUT_MS,
      jspi: cli.jspi,
      emit: (line) => lines.push(line),
      log: (msg) => console.error(msg),
    });
    await Deno.writeTextFile(cli.out, lines.join("\n") + "\n");
    console.error(
      `\n${counts.passed} passed | ${counts.failed} failed | ${counts.skipped} skipped ` +
        `(${counts.total} total) in ${((performance.now() - started) / 1000).toFixed(1)}s ` +
        `-> ${cli.out}`,
    );
    if (counts.failed > 0) Deno.exitCode = 1;
  } finally {
    echod.shutdown();
  }
}

if (import.meta.main) await main();
