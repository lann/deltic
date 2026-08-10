// The exam harness: relay lifecycle, artifact translation, and one typed
// handle on `polymorph:iroh/endpoint@0.1.0` per endpoint instance.
//
// Everything here is host wiring; the scenarios in `run.ts` carry the
// verdicts. The driving logic is ported from the consumer's own JS driver
// (polymorph-iroh/host-jco/src/run-endpoint.mjs) — the *logic*, not the jco
// wiring: that driver's `iroh.Endpoint.bind(...)` becomes this file's
// `bindEndpoint(...)` over `instantiate` + the embedder facade.

import { Translator } from "../../../runtime/src/shim/mod.ts";
import type { ComponentArtifacts } from "@deltic/runtime/embedder";
import { instantiate, WitError } from "@deltic/runtime/embedder";
import { wasiShims } from "../../../wasi-shims/src/mod.ts";
import { webcryptoImports } from "../../../ports/webcrypto/src/mod.ts";
import { websocketImports } from "../../../ports/websocket/src/websocket.ts";
import { webrtcImports } from "../../../ports/webrtc/src/webrtc.ts";
import { socketsImports } from "./sockets.ts";
import type {
  BindConfig,
  Endpoint,
  IdentityGenerateExports,
  IrohEndpointExports,
} from "./types.ts";

const CE_ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = "/home/lmartin/p/polymorph/polymorph-iroh";

/** The endpoint component. Read-only; never rebuilt into the consumer tree. */
export const ENDPOINT_WASM =
  `${CONSUMER}/target/wasm32-wasip2/release/iroh_endpoint.wasm`;
/** Rebuild landing zone, outside every consumer tree (dispatch rule). */
export const REBUILD_TARGET = "/tmp/opencode/c3-iroh-target";
export const REBUILT_WASM =
  `${REBUILD_TARGET}/wasm32-wasip2/release/iroh_endpoint.wasm`;
export const SHIM_WASM =
  `${CE_ROOT}target/wasm32-unknown-unknown/release/translator_shim.wasm`;

/** The stock upstream relay, built by the consumer's `just relay-build`. */
export const RELAY_BIN = `${CONSUMER}/.deps/iroh/target/release/iroh-relay`;
/** `iroh-relay --dev` serves ws on this address (their README). */
export const RELAY_PORT = 3340;
export const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;

export const IROH_ENDPOINT_INTERFACE = "polymorph:iroh/endpoint@0.1.0";
export const IDENTITY_GENERATE_INTERFACE = "polymorph:iroh/identity-generate@0.1.0";

// --- artifact ---------------------------------------------------------------

/**
 * The world the exam expects, checked before anything else runs. A prebuilt
 * consumer artifact can be stale (the webrtc echo-demo predated a package
 * rename), so the import set is the freshness test: if these are absent the
 * artifact predates the surface under exam and must be rebuilt.
 */
const REQUIRED_IMPORT_IDS = [
  "polymorph:webrtc-datachannels/connections@0.1.0",
  "polymorph:websocket/connections@0.1.0",
  "polymorph:webcrypto/ed25519-sign@0.1.0",
  "wasi:clocks/monotonic-clock@0.3.0",
  "wasi:sockets/types@0.3.0",
];

/**
 * Export-side freshness: the identity/options surface (the resource-shaped
 * `endpoint-options` and the `identity-generate` interface) postdates the
 * record-shaped bind an older artifact carries. An artifact without these
 * predates the surface under exam.
 */
const REQUIRED_EXPORT_IDS = [
  "polymorph:iroh/endpoint@0.1.0",
  "polymorph:iroh/identity-generate@0.1.0",
];

let cachedArtifacts: ComponentArtifacts | undefined;

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function rebuildEndpoint(): Promise<void> {
  console.error(`rebuilding iroh-endpoint into ${REBUILD_TARGET} …`);
  const built = await new Deno.Command("cargo", {
    args: [
      "build",
      "--locked",
      "--release",
      "-p",
      "iroh-endpoint",
      "--target",
      "wasm32-wasip2",
      "--manifest-path",
      `${CONSUMER}/Cargo.toml`,
    ],
    env: { CARGO_TARGET_DIR: REBUILD_TARGET },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!built.success) throw new Error("iroh-endpoint rebuild failed");
}

/**
 * Translate the endpoint component once. The plan and adapters are reused
 * across every `instantiate` in the run: two endpoint *instances* are two
 * separate component instances over the same immutable artifacts.
 */
export async function loadArtifacts(): Promise<ComponentArtifacts> {
  if (cachedArtifacts) return cachedArtifacts;
  if (!await exists(SHIM_WASM)) {
    throw new Error(
      `translator shim not found at ${SHIM_WASM} — build it with:\n` +
        `  cargo build -p translator-shim --target wasm32-unknown-unknown --release`,
    );
  }
  let path = ENDPOINT_WASM;
  if (!await exists(path)) {
    if (!await exists(REBUILT_WASM)) await rebuildEndpoint();
    path = REBUILT_WASM;
  }
  let bytes = await Deno.readFile(path);
  const translator = await Translator.create(await Deno.readFile(SHIM_WASM));
  let { plan, adapters } = translator.translate(bytes);

  const staleness = (p: typeof plan): string[] => {
    const imports = new Set(p.imports.map((i: { name: string }) => i.name));
    const exports = new Set(p.exports.map((e: { name: string }) => e.name));
    return [
      ...REQUIRED_IMPORT_IDS.filter((id) => !imports.has(id)),
      ...REQUIRED_EXPORT_IDS.filter((id) => !exports.has(id)),
    ];
  };
  const missing = staleness(plan);
  if (missing.length > 0) {
    // Staleness verdict: rebuild from source rather than fail on an old
    // artifact (the dispatch's CAUTION).
    console.error(
      `prebuilt ${path} is stale (missing ${missing.join(", ")}); rebuilding`,
    );
    await rebuildEndpoint();
    bytes = await Deno.readFile(REBUILT_WASM);
    ({ plan, adapters } = translator.translate(bytes));
    const still = staleness(plan);
    if (still.length > 0) {
      throw new Error(
        `rebuilt artifact still missing ${still.join(", ")} — the consumer ` +
          `checkout at ${CONSUMER} predates the surface under exam`,
      );
    }
  }
  cachedArtifacts = { plan, componentBytes: bytes, adapters };
  return cachedArtifacts;
}

// --- instances --------------------------------------------------------------

export interface EndpointInstanceOptions {
  /** Label used in log lines (`server`, `client`, …). */
  readonly label: string;
  /** Extra environment for the guest's `wasi:cli/environment`. */
  readonly env?: Record<string, string>;
}

export interface EndpointInstance {
  readonly label: string;
  readonly api: IrohEndpointExports;
  readonly identityGenerate: IdentityGenerateExports;
  /** Whatever the guest wrote to stdout/stderr through the WASI shims. */
  stdout(): string;
  stderr(): string;
}

/**
 * Stand up one component instance of the endpoint, with the committed ports
 * supplying every non-WASI import.
 *
 * Import fragments are built FRESH per instance: the ports' resource classes
 * carry per-instance registry identity, and sharing one record across two
 * instantiations would alias two guests onto one table.
 */
export async function newEndpointInstance(
  options: EndpointInstanceOptions,
): Promise<EndpointInstance> {
  const artifacts = await loadArtifacts();
  const shims = wasiShims({
    cli: {
      args: [`iroh-endpoint-${options.label}`],
      env: { ...options.env },
      passthrough: Deno.env.get("EXAM_GUEST_LOGS") === "1",
    },
  });
  const imports = {
    ...shims,
    // ports/webcrypto publishes SigningKeyOptions under the DEFINING
    // interface (`signature`) since the exam's first run found the gap;
    // the stock fragment now links this endpoint unmodified.
    ...webcryptoImports(),
    ...websocketImports(),
    ...webrtcImports(),
    ...socketsImports(),
  };
  const instance = await instantiate(artifacts, imports);
  const api = instance.exports[IROH_ENDPOINT_INTERFACE] as IrohEndpointExports;
  const identityGenerate = instance
    .exports[IDENTITY_GENERATE_INTERFACE] as IdentityGenerateExports;
  if (!api || typeof api.Endpoint?.bind !== "function") {
    throw new Error(
      `export "${IROH_ENDPOINT_INTERFACE}" missing or shapeless; plan exports: ` +
        artifacts.plan.exports.map((e: { name: string }) => e.name).join(", "),
    );
  }
  if (typeof identityGenerate?.generate !== "function") {
    throw new Error(`export "${IDENTITY_GENERATE_INTERFACE}" missing or shapeless`);
  }
  return {
    label: options.label,
    api,
    identityGenerate,
    stdout: () => shims.captured.stdoutText(),
    stderr: () => shims.captured.stderrText(),
  };
}

/**
 * `Endpoint.bind`, with the consumer driver's driving shape
 * (polymorph-iroh/host-jco/src/run-endpoint.mjs): generate an identity,
 * construct `endpoint-options` around it, populate the setters, bind. The
 * options resource is consumed by `bind`; the identity's borrow ends at the
 * constructor, so it is dropped once the endpoint is up.
 */
export async function bindEndpoint(
  instance: EndpointInstance,
  config: BindConfig,
): Promise<Endpoint> {
  const identity = await instance.identityGenerate.generate();
  const options = new instance.api.EndpointOptions(identity);
  for (const alpn of config.alpns) await options.addAlpn(alpn);
  if (config.relayUrl !== undefined) await options.relayUrl(config.relayUrl);
  if (config.udpBindAddr !== undefined) await options.udpBindAddr(config.udpBindAddr);
  if (config.webrtc) await options.webrtc(true);
  const endpoint = await instance.api.Endpoint.bind(options);
  identity.drop();
  return endpoint;
}

// --- relay ------------------------------------------------------------------

export interface Relay {
  readonly url: string;
  stop(): Promise<void>;
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `iroh-relay --dev` (ws on 127.0.0.1:3340) and wait for it to accept.
 *
 * If something is already listening on the port we adopt it rather than
 * racing a second binder — experiment-mosh finding 15c's port-conflict shape.
 * `enable_metrics = false` would go in a `--config-path` file if the metrics
 * port ever collides; not needed on this host (recorded in the report).
 */
export async function startRelay(): Promise<Relay> {
  if (await portOpen(RELAY_PORT)) {
    console.error(`relay: adopting an already-listening 127.0.0.1:${RELAY_PORT}`);
    return { url: RELAY_URL, stop: () => Promise.resolve() };
  }
  if (!await exists(RELAY_BIN)) {
    throw new Error(
      `iroh-relay not found at ${RELAY_BIN} — build it in the consumer tree with:\n` +
        `  (cd ${CONSUMER}/.deps/iroh && cargo build --release -p iroh-relay --features server --bin iroh-relay)`,
    );
  }
  const child = new Deno.Command(RELAY_BIN, {
    args: ["--dev"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Drain the pipes so the relay never blocks on a full stdio buffer, and
  // so `stop()` can close them without an unresolved-read sanitizer hit.
  const sink = (r: ReadableStream<Uint8Array>) =>
    r.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  const drained = Promise.all([sink(child.stdout), sink(child.stderr)]);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await portOpen(RELAY_PORT)) {
      console.error(`relay: iroh-relay --dev listening on ${RELAY_URL} (pid ${child.pid})`);
      return {
        url: RELAY_URL,
        stop: async () => {
          try {
            child.kill("SIGTERM");
          } catch { /* already gone */ }
          await child.status;
          await drained;
        },
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    child.kill("SIGKILL");
  } catch { /* ignore */ }
  await child.status;
  await drained;
  throw new Error(`iroh-relay did not listen on ${RELAY_PORT} within 15s`);
}

// --- small helpers ----------------------------------------------------------

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Endpoint ids are 64 hex chars; log them short (they are public keys). */
export const shortId = (bytes: Uint8Array): string => `${hex(bytes).slice(0, 12)}…`;

export const utf8 = new TextEncoder();
export const fromUtf8 = new TextDecoder();

/** Reject after `ms`, so a wedged scenario names itself instead of hanging. */
export function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/** Render a rejection, unwrapping the branded WIT error payload. */
export function describeError(err: unknown): string {
  if (err instanceof WitError) {
    const p = err.payload as { tag?: string; val?: unknown } | undefined;
    return `WitError ${p?.tag ?? "?"}${p?.val === undefined ? "" : `(${String(p.val)})`}`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
