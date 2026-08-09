// Gate 2: run the consumer's REAL echo-demo component end-to-end through
// component-engine, with `ports/webrtc` supplying
// `polymorph:webrtc-datachannels/connections@0.1.0` — mirroring
// `ports/websocket/conformance/run.ts`'s pattern (Translator.create + the
// shim wasm32 module, run AT RUNTIME under Deno, not a build-time step).
//
// The world under test (`webrtc-echo-demo`,
// polymorph-webrtc-datachannels/examples/echo-demo/wit/webrtc-echo.wit)
// imports ONLY `connections` and exports `demo.run` — the component itself
// stands up BOTH peers (an offerer and an in-component echo answerer)
// through the standard `connections` interface, so no rendezvous/signaling
// import is needed for this artifact (unlike `webrtc-echo-remote`, which
// needs an additional `rendezvous` import for a genuine two-process run —
// out of scope here).
//
// Skip-if-absent: the artifact and the translator shim are real build
// products, not checked in here; if either is missing this script reports
// precisely why rather than failing loudly on a laptop.
//
//   deno run -A ports/webrtc/conformance/echo-demo.ts

import { Translator } from "../../../runtime/src/shim/mod.ts";
import type { ComponentArtifacts } from "@component-engine/runtime/embedder";
import { instantiate } from "@component-engine/runtime/embedder";
import { webrtcImports } from "../src/webrtc.ts";

const CE_ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = "/home/lmartin/p/polymorph/polymorph-webrtc-datachannels";
// The committed artifact (`examples/echo-demo/build/echo-demo.component.wasm`,
// gitignored per the consumer's own .gitignore) predates a package rename
// (`lann:webrtc-datachannels` -> `polymorph:webrtc-datachannels`) and fails
// to link against this port. `ensureArtifact` rebuilds a fresh one OUTSIDE
// the consumer tree (redirected `CARGO_TARGET_DIR`, matching
// ports/websocket/conformance/run.ts's `ensureEchod` discipline), reading
// only `examples/echo-demo/{Cargo.toml,src,wit}` — nothing here writes into
// the consumer tree.
const REBUILD_TARGET = "/tmp/opencode/c3-rtc-target";
const ARTIFACT = "/tmp/opencode/c3-rtc-build/echo-demo.component.wasm";
const SHIM_WASM = `${CE_ROOT}target/wasm32-unknown-unknown/release/translator_shim.wasm`;

async function ensureArtifact(): Promise<void> {
  try {
    const st = await Deno.stat(ARTIFACT);
    if (st.isFile) return;
  } catch { /* build it */ }
  console.error(`building echo-demo.component.wasm into ${REBUILD_TARGET} …`);
  const built = await new Deno.Command("cargo", {
    args: [
      "build",
      "--release",
      "-p",
      "echo-demo",
      "--target",
      "wasm32-unknown-unknown",
      "--manifest-path",
      `${CONSUMER}/Cargo.toml`,
    ],
    env: { CARGO_TARGET_DIR: REBUILD_TARGET },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!built.success) throw new Error("echo-demo build failed");
  await Deno.mkdir("/tmp/opencode/c3-rtc-build", { recursive: true });
  const wasmTools = await new Deno.Command("wasm-tools", {
    args: [
      "component",
      "new",
      `${REBUILD_TARGET}/wasm32-unknown-unknown/release/echo_demo.wasm`,
      "-o",
      ARTIFACT,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!wasmTools.success) throw new Error("wasm-tools component new failed");
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

async function loadArtifacts(bytes: Uint8Array): Promise<ComponentArtifacts> {
  const shimBytes = await Deno.readFile(SHIM_WASM);
  const translator = await Translator.create(shimBytes);
  const { plan, adapters } = translator.translate(bytes);
  return { plan, componentBytes: bytes, adapters };
}

interface DemoStats {
  messagesSent: number;
  messagesReceived: number;
  bytesEchoed: bigint;
}

async function main() {
  await ensureArtifact();
  const artifactBytes = await readIfPresent(ARTIFACT);
  if (artifactBytes === null) {
    console.error(`SKIP: echo-demo artifact still not found at ${ARTIFACT} after build.`);
    Deno.exit(0);
  }
  const shimBytes = await readIfPresent(SHIM_WASM);
  if (shimBytes === null) {
    console.error(
      `SKIP: translator shim not found at ${SHIM_WASM} — build it with:\n` +
        `  cargo build -p translator-shim --target wasm32-unknown-unknown --release`,
    );
    Deno.exit(0);
  }

  console.error(`translating ${ARTIFACT} …`);
  const artifacts = await loadArtifacts(artifactBytes);
  console.error(
    `plan loaded: ${artifacts.plan.imports.length} import(s), ` +
      `${artifacts.plan.exports.length} export(s)`,
  );
  for (const exp of artifacts.plan.exports) {
    console.error(`  export: ${exp.name}`);
  }

  const imports = { ...webrtcImports() };
  const instance = await instantiate(artifacts, imports);

  // The world exports the `demo` interface; find its export by the
  // fully-qualified WIT id (contracts/embedder-api.md: "interface key in
  // the imports/exports record: fully-qualified WIT id verbatim, version
  // included").
  const demoExport = artifacts.plan.exports.find((e) =>
    e.name.includes("webrtc-echo/demo")
  );
  if (!demoExport) {
    console.error(
      "BLOCKED: no export matching '.../demo@...' found in plan.exports:\n" +
        artifacts.plan.exports.map((e: { name: string }) => `  ${e.name}`).join("\n"),
    );
    Deno.exit(1);
  }
  // deno-lint-ignore no-explicit-any
  const demo = instance.exports[demoExport.name] as any;
  console.error(`resolved export "${demoExport.name}": run=${typeof demo.run}`);

  const MESSAGE_COUNT = 50;
  const MESSAGE_SIZE = 512;
  const started = performance.now();
  const stats = await demo.run({
    messageCount: MESSAGE_COUNT,
    messageSize: MESSAGE_SIZE,
  }) as DemoStats;
  const elapsed = performance.now() - started;

  console.error("echo-demo (component-engine / ports/webrtc host) result:");
  console.error(`  messages sent:     ${stats.messagesSent}`);
  console.error(`  messages received: ${stats.messagesReceived}`);
  console.error(`  bytes echoed:      ${stats.bytesEchoed}`);
  console.error(`  elapsed:           ${elapsed.toFixed(1)} ms`);

  const expectedBytes = BigInt(MESSAGE_COUNT * MESSAGE_SIZE);
  if (stats.messagesSent !== MESSAGE_COUNT) {
    throw new Error(`expected ${MESSAGE_COUNT} sent, got ${stats.messagesSent}`);
  }
  if (stats.messagesReceived !== MESSAGE_COUNT) {
    throw new Error(`expected ${MESSAGE_COUNT} received, got ${stats.messagesReceived}`);
  }
  if (stats.bytesEchoed !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes echoed, got ${stats.bytesEchoed}`);
  }
  console.error("\nOK: every message round-tripped through the WebRTC data channel.");
}

if (import.meta.main) await main();
