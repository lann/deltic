// Integration gate: the REAL `wasi:http@0.3.0-rc` outbound surface end to
// end — the http-fetch fixture (examples/guests/http-fetch, types.wit
// vendored verbatim) instantiated behind the runtime, with the fetch-backed
// provider serving a live loopback `Deno.serve`. The composed path:
//
//   guest wit-bindgen calls -> plan dispatch -> conventions adapter
//   (host resource constructors, A12 future results in tuples, guest-
//   created trailers/res futures crossing INTO the host) -> fetch ->
//   loopback HTTP -> streamed response body back into the guest
//
// Skip-if-absent on the shim + fixture corpus, like the sockets gate.

import { assertEq, assertTrue } from "./asserts.ts";
import { Translator } from "@deltic/runtime/shim";
import { instantiate } from "@deltic/runtime/embedder";
import { http } from "../src/http.ts";

const FIXTURE = new URL(
  "../../examples/guests/build/http-fetch.component.wasm",
  import.meta.url,
);
const SHIM_WASM = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);

async function readIfPresent(path: URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

const componentBytes = await readIfPresent(FIXTURE);
const shimWasm = await readIfPresent(SHIM_WASM);
const ready = componentBytes !== null && shimWasm !== null;

// deno-lint-ignore no-explicit-any
async function instantiateFixture(calls?: string[]): Promise<any> {
  const translator = await Translator.create(shimWasm!);
  const { plan, adapters } = translator.translate(componentBytes!);
  return await instantiate({ plan, componentBytes: componentBytes!, adapters }, {
    ...http(calls === undefined ? {} : { onCall: (c) => calls.push(c) }).imports,
  });
}

function serve(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ authority: string; shutdown: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen({ port }) {
        resolve({ authority: `127.0.0.1:${port}`, shutdown: () => server.shutdown() });
      },
    }, handler);
  });
}

Deno.test({
  name: "integration: guest GET through fetch — status, streamed body, driving sequence",
  ignore: !ready,
  async fn() {
    const server = await serve((req) => {
      assertEq(new URL(req.url).pathname, "/hello");
      return new Response("hello from the loopback", { status: 203 });
    });
    try {
      const calls: string[] = [];
      const c = await instantiateFixture(calls);
      const [status, body] = await c.exports.get(server.authority, "/hello") as [
        number,
        Uint8Array,
      ];
      assertEq(status, 203);
      assertEq(new TextDecoder().decode(body), "hello from the loopback");
      assertTrue(calls.includes("request.new"), "constructor dispatched");
      assertTrue(calls.includes("client.send"), "send dispatched");
      assertTrue(calls.includes("response.consume-body"), "consume-body dispatched");
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "integration: guest POST — a guest-written body stream crosses fetch and echoes back",
  ignore: !ready,
  async fn() {
    const server = await serve(async (req) => new Response(await req.bytes()));
    try {
      const c = await instantiateFixture();
      const payload = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
      const echoed = await c.exports.postEcho(server.authority, "/echo", payload) as Uint8Array;
      assertEq(echoed.length, payload.length);
      assertTrue(
        echoed.every((b, i) => b === payload[i]),
        "the body is byte-identical after guest->fetch->server->fetch->guest",
      );
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "integration: a refused dial reaches the guest as the error-code's err case",
  ignore: !ready,
  async fn() {
    const probe = await serve(() => new Response("x"));
    await probe.shutdown(); // free port: refused
    const c = await instantiateFixture();
    let threw: unknown;
    try {
      await c.exports.get(probe.authority, "/");
    } catch (e) {
      threw = e;
    }
    // The guest maps the err case to a debug string it returns as its own
    // result err — which the conventions surface as a ComponentException.
    assertTrue(threw !== undefined, "the guest observed the error");
    assertTrue(
      String((threw as { payload?: unknown })?.payload ?? threw).includes("ConnectionRefused"),
      `the error names the refusal, got: ${(threw as { payload?: unknown })?.payload}`,
    );
  },
});
