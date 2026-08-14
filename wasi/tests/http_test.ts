// Unit tests for the fetch-backed `wasi:http` provider (src/http.ts):
// fields semantics, the request/response state machines, and `client.send`
// against a live loopback `Deno.serve` — plus the recorded divergences
// (manual redirects, untransmissible request trailers, the real
// first-byte/between-bytes timeouts).
//
// Fallible methods must throw BRANDED ComponentExceptions; `error-code`
// case names are the WIT spellings VERBATIM (`DNS-timeout`,
// `internal-error` — capitals included).

import { ComponentException } from "@deltic/runtime/embedder";
import {
  HTTP_TRACK,
  type ErrorCode,
  type Fields,
  http,
  type HttpResult,
  type Request,
  type Response,
  type TrailersResult,
} from "../src/http.ts";
import { assertEq, assertRejects, assertThrows, assertTrue } from "./asserts.ts";

const { Fields, Request, RequestOptions, Response, send, imports } = http();

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

function errKind(fn: () => unknown): string {
  const e = assertThrows(fn);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException<{ kind: string }>).payload.kind;
}

async function errKindAsync(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException<ErrorCode>).payload.kind;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: number[] = [];
  for await (const c of stream) chunks.push(...c);
  return Uint8Array.from(chunks);
}

const okTrailers: Promise<TrailersResult> = Promise.resolve({ kind: "ok", value: undefined });
const okRes: Promise<HttpResult> = Promise.resolve({ kind: "ok" });

/** A request aimed at 127.0.0.1:port over plain http. */
function loopbackRequest(
  port: number,
  path: string,
  extras: {
    method?: Parameters<Request["setMethod"]>[0];
    headers?: [string, Uint8Array][];
    contents?: AsyncIterable<Uint8Array>;
    trailers?: Promise<TrailersResult>;
  } = {},
): [Request, Promise<HttpResult>] {
  const headers = Fields.fromList(extras.headers ?? []);
  const [request, transmitted] = Request["new"](
    headers,
    extras.contents,
    extras.trailers ?? okTrailers,
    undefined,
  );
  if (extras.method !== undefined) request.setMethod(extras.method);
  request.setScheme({ kind: "HTTP" });
  request.setAuthority(`127.0.0.1:${port}`);
  request.setPathWithQuery(path);
  return [request, transmitted];
}

/** A loopback HTTP server for one test. */
function serve(
  handler: (req: globalThis.Request) => globalThis.Response | Promise<globalThis.Response>,
): Promise<{ port: number; shutdown: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen({ port }) {
        resolve({ port, shutdown: () => server.shutdown() });
      },
    }, handler);
  });
}

// --- fields ---------------------------------------------------------------------

Deno.test("http fields: case-insensitive lookup, original casing preserved", () => {
  const f = Fields.fromList([["X-Test", text("a")], ["x-test", text("b")]]);
  assertEq(f.has("X-TEST"), true);
  assertEq(f.get("x-Test").map(utf8).join(","), "a,b");
  assertEq(
    JSON.stringify(f.copyAll().map(([k, v]) => [k, utf8(v)])),
    JSON.stringify([["X-Test", "a"], ["x-test", "b"]]),
    "original casing and order survive",
  );
});

Deno.test("http fields: set/append/delete/get-and-delete; from-list validation", () => {
  const f = new Fields();
  f.set("a", [text("1")]);
  f.append("a", text("2"));
  assertEq(f.get("a").map(utf8).join(","), "1,2");
  assertEq(f.getAndDelete("a").map(utf8).join(","), "1,2");
  assertEq(f.has("a"), false);
  f.set("b", [text("x")]);
  f.delete("b");
  assertEq(f.has("b"), false);
  assertEq(errKind(() => Fields.fromList([["bad header", text("v")]])), "invalid-syntax");
  assertEq(errKind(() => f.set("ok", [text("bad\r\nvalue")])), "invalid-syntax");
});

Deno.test("http fields: immutability — request views refuse mutation, clone is mutable", () => {
  const headers = Fields.fromList([["x-a", text("1")]]);
  const [request] = Request["new"](headers, undefined, okTrailers, undefined);
  const view = request.getHeaders();
  assertEq(errKind(() => view.set("x-a", [text("2")])), "immutable");
  assertEq(errKind(() => view.delete("x-a")), "immutable");
  assertEq(errKind(() => view.append("x-a", text("2"))), "immutable");
  const cloned = view.clone();
  cloned.set("x-a", [text("2")]); // no throw: clones are mutable
  assertEq(utf8(cloned.get("x-a")[0]), "2");
  // The ORIGINAL fields handle also became immutable at `new` (ownership
  // transferred to the request).
  assertEq(errKind(() => headers.set("x-a", [text("3")])), "immutable");
  request[Symbol.dispose]();
});

// --- request accessors ------------------------------------------------------------

Deno.test("http request: accessor defaults, round trips, and validation", () => {
  const [request] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  assertEq(request.getMethod().kind, "get");
  assertEq(request.getPathWithQuery(), undefined);
  assertEq(request.getScheme(), undefined);
  assertEq(request.getAuthority(), undefined);
  request.setMethod({ kind: "post" });
  assertEq(request.getMethod().kind, "post");
  request.setPathWithQuery("/x?y=1");
  assertEq(request.getPathWithQuery(), "/x?y=1");
  request.setScheme({ kind: "HTTPS" });
  assertEq(request.getScheme()?.kind, "HTTPS");
  request.setAuthority("example.com:8443");
  assertEq(request.getAuthority(), "example.com:8443");
  assertThrows(() => request.setMethod({ kind: "other", value: "not a token" }));
  assertThrows(() => request.setPathWithQuery("/sp ace"));
  assertThrows(() => request.setScheme({ kind: "other", value: "9bad" }));
  request[Symbol.dispose]();
});

Deno.test("http request-options: byte timeouts stored; connect-timeout honestly refused", () => {
  const o = new RequestOptions();
  assertEq(o.getConnectTimeout(), undefined);
  o.setFirstByteTimeout(5_000_000_000n);
  assertEq(o.getFirstByteTimeout(), 5_000_000_000n);
  o.setBetweenBytesTimeout(1_000_000n);
  assertEq(o.getBetweenBytesTimeout(), 1_000_000n);
  assertEq(errKind(() => o.setConnectTimeout(1n)), "not-supported");
  const c = o.clone();
  assertEq(c.getFirstByteTimeout(), 5_000_000_000n);
});

// --- client.send over a live server -------------------------------------------------

Deno.test("http send: GET round trip — status, headers, streamed body; transmission ok", async () => {
  const server = await serve((req) => {
    assertEq(new URL(req.url).pathname, "/hello");
    assertEq(req.headers.get("x-probe"), "42");
    return new globalThis.Response("hi there", { headers: { "x-answer": "97" } });
  });
  try {
    const [request, transmitted] = loopbackRequest(server.port, "/hello", {
      headers: [["x-probe", text("42")]],
    });
    const response = await send(request);
    assertEq(response.getStatusCode(), 200);
    assertEq(utf8(response.getHeaders().get("x-answer")[0]), "97");
    const [body, trailers] = Response.consumeBody(response, okRes);
    assertEq(utf8(await collect(body)), "hi there");
    assertEq((await trailers).kind, "ok");
    assertEq((await transmitted).kind, "ok");
    response[Symbol.dispose]();
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: POST body is transmitted (buffered divergence), echo returns", async () => {
  const server = await serve(async (req) => new globalThis.Response(await req.bytes()));
  try {
    const [request] = loopbackRequest(server.port, "/echo", {
      method: { kind: "post" },
      contents: (async function* () {
        yield text("hello ");
        yield text("fetch");
      })(),
    });
    const response = await send(request);
    const [body] = Response.consumeBody(response, okRes);
    assertEq(utf8(await collect(body)), "hello fetch");
    response[Symbol.dispose]();
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: redirects are NOT followed (manual, the wasmtime-parity stance)", async () => {
  const server = await serve((req) =>
    new URL(req.url).pathname === "/from"
      ? new globalThis.Response(null, { status: 302, headers: { location: "/to" } })
      : new globalThis.Response("followed?!")
  );
  try {
    const [request] = loopbackRequest(server.port, "/from");
    const response = await send(request);
    assertEq(response.getStatusCode(), 302);
    assertEq(utf8(response.getHeaders().get("location")[0]), "/to");
    response[Symbol.dispose]();
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: a refused connection maps to connection-refused (branded)", async () => {
  const probe = await serve(() => new globalThis.Response("x"));
  await probe.shutdown(); // the port is now free: dials get refused
  const [request, transmitted] = loopbackRequest(probe.port, "/");
  assertEq(await errKindAsync(send(request)), "connection-refused");
  assertEq((await transmitted).kind, "err");
});

Deno.test("http send: no authority is HTTP-request-URI-invalid; non-fetch scheme refused", async () => {
  const [r1] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  r1.setScheme({ kind: "HTTP" });
  assertEq(await errKindAsync(send(r1)), "HTTP-request-URI-invalid");
  const [r2] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  r2.setScheme({ kind: "other", value: "gopher" });
  r2.setAuthority("example.com");
  assertEq(await errKindAsync(send(r2)), "internal-error");
});

Deno.test("http send: request trailers cannot ride fetch — some(trailers) fails loudly", async () => {
  const server = await serve(() => new globalThis.Response("x"));
  try {
    const [request, transmitted] = loopbackRequest(server.port, "/", {
      trailers: Promise.resolve<TrailersResult>({ kind: "ok", value: new Fields() }),
    });
    assertEq(await errKindAsync(send(request)), "internal-error");
    assertEq((await transmitted).kind, "err");
  } finally {
    await server.shutdown();
  }
});

Deno.test("http send: an erring trailers future aborts the request, per the WIT", async () => {
  const server = await serve(() => new globalThis.Response("x"));
  try {
    const [request, transmitted] = loopbackRequest(server.port, "/", {
      trailers: Promise.resolve<TrailersResult>({
        kind: "err",
        value: { kind: "internal-error", value: "guest gave up" },
      }),
    });
    assertEq(await errKindAsync(send(request)), "internal-error");
    const t = await transmitted;
    assertEq(t.kind, "err");
  } finally {
    await server.shutdown();
  }
});

// --- response body timeouts ---------------------------------------------------------

Deno.test("http timeouts: first-byte timeout errs the body future, not the send", async () => {
  // Headers arrive; the body never does.
  const server = await serve(() =>
    new globalThis.Response(
      new ReadableStream<Uint8Array>({ start() {/* never enqueues */} }),
    )
  );
  try {
    const headers = Fields.fromList([]);
    const options = new RequestOptions();
    options.setFirstByteTimeout(50_000_000n); // 50ms
    const [request] = Request["new"](headers, undefined, okTrailers, options);
    request.setScheme({ kind: "HTTP" });
    request.setAuthority(`127.0.0.1:${server.port}`);
    request.setPathWithQuery("/");
    const response = await send(request); // headers made it: send succeeds
    const [body, done] = Response.consumeBody(response, okRes);
    assertEq((await collect(body)).length, 0, "the stream ends without fake data");
    const t = await done;
    assertEq(t.kind, "err");
    assertEq(
      (t as { kind: "err"; value: ErrorCode }).value.kind,
      "HTTP-response-timeout",
    );
  } finally {
    await server.shutdown();
  }
});

// --- guest-constructed bodies (the middleware shapes) --------------------------------

Deno.test("http consume-body: a constructed request's body and trailers pass through; res settles transmission", async () => {
  const trailerFields = new Fields();
  trailerFields.set("x-check", [text("sum")]);
  const [request, transmitted] = Request["new"](
    Fields.fromList([]),
    (async function* () {
      yield text("payload");
    })(),
    Promise.resolve<TrailersResult>({ kind: "ok", value: trailerFields }),
    undefined,
  );
  let settleRes!: (r: HttpResult) => void;
  const res = new Promise<HttpResult>((r) => (settleRes = r));
  const [body, trailers] = Request.consumeBody(request, res);
  assertEq(utf8(await collect(body)), "payload");
  const t = await trailers;
  assertEq(t.kind, "ok");
  assertTrue(t.kind === "ok" && t.value !== undefined, "trailers arrive");
  settleRes({ kind: "ok" });
  assertEq((await transmitted).kind, "ok", "res settles the transmission future");
});

Deno.test("http dispose: an unsent request settles its transmission future as err", async () => {
  const [request, transmitted] = Request["new"](new Fields(), undefined, okTrailers, undefined);
  request[Symbol.dispose]();
  const t = await transmitted;
  assertEq(t.kind, "err");
});

// --- fragment shape -------------------------------------------------------------------

Deno.test("http fragment: the @0.3 track by default; rc snapshots re-key exactly", () => {
  assertTrue(
    `wasi:http/types@${HTTP_TRACK}` in imports &&
      `wasi:http/client@${HTTP_TRACK}` in imports,
    "track keys registered",
  );
  const calls: string[] = [];
  const custom = http({ version: "0.3.0-rc-2099-01-01", onCall: (c) => calls.push(c) });
  assertTrue("wasi:http/types@0.3.0-rc-2099-01-01" in custom.imports, "rc override re-keys exactly");
  new custom.Fields();
  assertEq(JSON.stringify(calls), JSON.stringify(["fields.constructor"]));
});
