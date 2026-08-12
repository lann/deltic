// Unit tests for the `polymorph:websocket/connections` port, against a
// local Deno echo server (tests/echo_server.ts).
//
// Scope: the LOGIC ported from the consumer's reference host — connect,
// send/receive of both message kinds, subprotocol negotiation and the
// offer-enforcement rule, close-argument validation, receive-via-stream
// (happy path and the single-use rule), the overflow close under a shrunk
// buffer bound, and the connect bound. The full behavioral surface is the
// consumer's own conformance suite, executed by conformance/run.ts.

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.0";
import { ComponentException } from "../../../runtime/src/embedder/mod.ts";
import {
  currentConfig,
  resetConfig,
  setConnectTimeoutMs,
  setMaxInboundBufferBytes,
  type StreamMessage,
  type WebsocketError,
  Websocket,
} from "../src/websocket.ts";
import { burstPayload, startEchoServer, type TestServer } from "./echo_server.ts";

/** Assert `fn` throws a branded `ComponentException` whose payload kind is `kind`. */
function assertComponentExceptionKind(fn: () => unknown, kind: WebsocketError["kind"]): WebsocketError {
  const e = assertThrows(fn, ComponentException) as ComponentException<WebsocketError>;
  assertEquals(e.payload.kind, kind);
  return e.payload;
}

async function assertRejectsComponentExceptionKind(
  fn: () => Promise<unknown>,
  kind: WebsocketError["kind"],
): Promise<WebsocketError> {
  const e = await assertRejects(fn, ComponentException) as ComponentException<WebsocketError>;
  assertEquals(e.payload.kind, kind);
  return e.payload;
}

async function withServer(fn: (s: TestServer) => Promise<void>): Promise<void> {
  resetConfig();
  const server = await startEchoServer();
  try {
    await fn(server);
  } finally {
    await server.close();
    resetConfig();
  }
}

Deno.test("connect + echo: text and binary round-trip, kinds preserved", async () => {
  await withServer(async (s) => {
    const ws = await Websocket.connect(`${s.base}/echo`, []);
    assertEquals(ws.protocol(), "");
    assertEquals(ws.state(), "open");

    await ws.send({ kind: "string", value: "héllo — 你好 🦀" });
    const text = await ws.receive();
    assertEquals(text, { kind: "string", value: "héllo — 你好 🦀" });

    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    await ws.send({ kind: "binary", value: payload });
    const bin = await ws.receive();
    assertEquals(bin.kind, "binary");
    assertEquals(bin.value as Uint8Array, payload);

    ws.close(1000, "bye");
    const info = await ws.waitClosed();
    assertEquals(ws.state(), "closed");
    // The test server does not echo the close frame's code/reason, so only
    // the *shape* is asserted here; the consumer's echod does, and its
    // `close/local` case asserts the round-trip.
    assert(info === undefined || typeof info.code === "number");
  });
});

Deno.test("subprotocol: negotiated when offered and selected", async () => {
  await withServer(async (s) => {
    const ws = await Websocket.connect(`${s.base}/echo?protocol=beta`, ["alpha", "beta"]);
    assertEquals(ws.protocol(), "beta");
    ws.close(1000, "");
    await ws.waitClosed();
  });
});

Deno.test("subprotocol: offered but none selected fails connect-failed", async () => {
  await withServer(async (s) => {
    // The WIT binds the server: "the connection fails if the server ...
    // selects none at all" (wit/websocket.wit:181-185).
    await assertRejectsComponentExceptionKind(
      () => Websocket.connect(`${s.base}/echo`, ["alpha"]),
      "connect-failed",
    );
  });
});

Deno.test("subprotocol: a malformed offer fails invalid-argument, eagerly", async () => {
  await withServer(async (s) => {
    for (const protocols of [["dup", "dup"], ["has space"], [""], ["bad,comma"]]) {
      await assertRejectsComponentExceptionKind(
        () => Websocket.connect(`${s.base}/echo`, protocols),
        "invalid-argument",
      );
    }
  });
});

Deno.test("connect: invalid URLs fail invalid-url, eagerly", async () => {
  await withServer(async (s) => {
    const host = s.base.slice("ws://".length);
    for (
      const url of [
        `http://${host}/echo`,
        `${s.base}/echo#fragment`,
        `ws://user:secret@${host}/echo`,
        "not a url",
        "/echo",
      ]
    ) {
      await assertRejectsComponentExceptionKind(() => Websocket.connect(url, []), "invalid-url");
    }
  });
});

Deno.test("close: argument validation is eager and leaves the connection usable", async () => {
  await withServer(async (s) => {
    const ws = await Websocket.connect(`${s.base}/echo`, []);
    for (const code of [0, 999, 1001, 1005, 1006, 1015, 2999, 5000, 65535]) {
      assertComponentExceptionKind(() => ws.close(code, ""), "invalid-argument");
    }
    // A reason needs a code; 124 bytes is one too many; 123 is exact.
    assertComponentExceptionKind(() => ws.close(undefined, "reason"), "invalid-argument");
    assertComponentExceptionKind(() => ws.close(1000, "r".repeat(124)), "invalid-argument");
    // The bound counts UTF-8 bytes, not code units: 42 three-byte chars
    // overflow, 41 fit exactly.
    assertComponentExceptionKind(() => ws.close(4000, "€".repeat(42)), "invalid-argument");

    // A rejected close left the connection usable.
    await ws.send({ kind: "binary", value: new Uint8Array([7, 7, 7]) });
    const echoed = await ws.receive();
    assertEquals(echoed.value as Uint8Array, new Uint8Array([7, 7, 7]));

    assertEquals(ws.state(), "open");
    ws.close(4999, "€".repeat(41));
    assertEquals(ws.state() === "open", false);
    await ws.waitClosed();
  });
});

Deno.test("close: local close discards the backlog and latches", async () => {
  await withServer(async (s) => {
    const ws = await Websocket.connect(`${s.base}/echo`, []);
    await ws.send({ kind: "binary", value: new Uint8Array([1, 2, 3]) });
    ws.close(1000, "");
    // Idempotent: a second close is a no-op, not an error.
    ws.close(4000, "second");
    await assertRejectsComponentExceptionKind(() => ws.receive(), "closed");
    await assertRejectsComponentExceptionKind(
      () => ws.send({ kind: "binary", value: new Uint8Array([1]) }),
      "closed",
    );
    await ws.waitClosed();
    assertEquals(ws.state(), "closed");
  });
});

Deno.test("receive-via-stream: happy path delivers one stream-message per message", async () => {
  await withServer(async (s) => {
    const ws = await Websocket.connect(`${s.base}/echo`, []);
    const sent = [
      { kind: "binary", value: new Uint8Array([9, 8, 7, 6]) } as const,
      { kind: "string", value: "streamed téxt ✓" } as const,
    ];
    for (const m of sent) await ws.send(m);

    const stream = ws.receiveViaStream();
    const reader = stream.getReader();
    const got: { kind: string; bytes: Uint8Array }[] = [];
    while (got.length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      const m = value as StreamMessage;
      const bytes = await drainBytes(m.data as ReadableStream<Uint8Array>);
      assertEquals(bytes.length, m.length);
      got.push({ kind: m.kind, bytes });
    }
    assertEquals(got.length, 2);
    assertEquals(got[0].kind, "binary");
    assertEquals(got[0].bytes, new Uint8Array([9, 8, 7, 6]));
    assertEquals(got[1].kind, "string");
    assertEquals(new TextDecoder().decode(got[1].bytes), "streamed téxt ✓");

    reader.cancel();
    ws.close(1000, "");
    await ws.waitClosed();
  });
});

Deno.test("receive-via-stream: single-use; pending receive is rejected", async () => {
  await withServer(async (s) => {
    const ws = await Websocket.connect(`${s.base}/echo`, []);
    // A receive pending when the stream claims the connection must resolve
    // with `receiving-via-stream` (wit/websocket.wit:239-243).
    const pending = ws.receive();
    const stream = ws.receiveViaStream();
    await assertRejectsComponentExceptionKind(() => pending, "receiving-via-stream");
    assertComponentExceptionKind(() => ws.receiveViaStream(), "receiving-via-stream");
    await assertRejectsComponentExceptionKind(() => ws.receive(), "receiving-via-stream");
    await stream.cancel();
    ws.close(1000, "");
    await ws.waitClosed();
  });
});

Deno.test("flow control: overflow closes, backlog stays receivable, then overflow error", async () => {
  await withServer(async (s) => {
    // A shrunk bound so a modest burst overflows it deterministically.
    setMaxInboundBufferBytes(8 * 1024);
    assertEquals(currentConfig().maxInboundBufferBytes, 8 * 1024);
    const floodCount = 64;
    const ws = await Websocket.connect(
      `${s.base}/burst?count=${floodCount}&size=1024`,
      [],
    );
    await ws.waitClosed();

    let drained = 0;
    for (;;) {
      let message;
      try {
        message = await ws.receive();
      } catch (e) {
        assertEquals((e as ComponentException<WebsocketError>).payload.kind, "receive-buffer-overflow");
        break;
      }
      assertEquals(message.value as Uint8Array, burstPayload(drained, 1024));
      drained += 1;
      assert(drained <= floodCount, "received more messages than were sent");
    }
    assert(drained > 0, "pre-overflow backlog was not receivable");
    assert(drained < floodCount, "the buffer bound did not engage");
  });
});

Deno.test("flow control: a message larger than the whole bound overflows immediately", async () => {
  await withServer(async (s) => {
    setMaxInboundBufferBytes(4 * 1024);
    const ws = await Websocket.connect(`${s.base}/burst?count=1&size=8192`, []);
    // Nothing precedes it in the backlog: the very first receive observes
    // the overflow (wit/websocket.wit:165-169).
    await assertRejectsComponentExceptionKind(() => ws.receive(), "receive-buffer-overflow");
  });
});

Deno.test("connect: the handshake bound fires as connect-failed", async () => {
  await withServer(async (s) => {
    setConnectTimeoutMs(250);
    const started = performance.now();
    const payload = await assertRejectsComponentExceptionKind(
      () => Websocket.connect(`${s.base}/stall`, []),
      "connect-failed",
    );
    const elapsed = performance.now() - started;
    assert(elapsed < 5_000, `connect bound did not fire promptly (${elapsed}ms)`);
    assert("value" in payload && typeof payload.value === "string");
  });
});

async function drainBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
