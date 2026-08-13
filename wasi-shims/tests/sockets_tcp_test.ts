// Unit tests for the `wasi:sockets/types@0.3` TCP provider
// (src/sockets.ts — the client half, issue #4's wosh consumer shape):
// the connect state machine, the stream-shaped send/receive data path
// against a real loopback `Deno.listen` server, the futures-not-throws
// error contract, and the WIT's shared-ownership teardown.
//
// `send`/`receive` never throw: their WIT signatures carry no result —
// every failure rides the returned future as a `{ kind: "err", value }`
// result value. Only create/connect/get-*-address may throw, and those
// throws must be BRANDED ComponentExceptions (a bare throw would be a
// guest trap).

import { ComponentException } from "@deltic/runtime/embedder";
import {
  type IpSocketAddress,
  type SocketErrorCode,
  type SocketResult,
  sockets,
  type TcpSocket,
} from "../src/sockets.ts";
import { assertEq, assertThrows, assertTrue } from "./asserts.ts";

const { TcpSocket } = sockets();

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});

const v6 = (
  address: [number, number, number, number, number, number, number, number],
  port: number,
  scopeId = 0,
): IpSocketAddress => ({
  kind: "ipv6",
  value: { port, flowInfo: 0, address, scopeId },
});

/** The payload kind of a thrown, branded socket error. */
function errKind(fn: () => unknown): string {
  const e = assertThrows(fn);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<SocketErrorCode>).payload).kind;
}

async function errKindAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
    return ((e as ComponentException<SocketErrorCode>).payload).kind;
  }
  throw new Error("expected a rejection");
}

/** The err-value kind of a settled tcp future. */
function resultErrKind(r: SocketResult): string {
  assertEq(r.kind, "err");
  return r.kind === "err" ? r.value.kind : "";
}

function dispose(socket: TcpSocket): void {
  socket[Symbol.dispose]();
}

async function* chunksOf(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield Uint8Array.from(c);
}

async function collect(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) out.push(...chunk);
  return out;
}

interface TestServer {
  addr: IpSocketAddress;
  done: Promise<void>;
  close(): void;
}

/** A one-connection loopback server driving `handler` on the accepted conn. */
function tcpServer(handler: (conn: Deno.TcpConn) => Promise<void>): TestServer {
  const listener = Deno.listen({ transport: "tcp", hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  const done = (async () => {
    const conn = await listener.accept();
    try {
      await handler(conn as Deno.TcpConn);
    } finally {
      try {
        conn.close();
      } catch {
        // Already closed by the handler.
      }
      listener.close();
    }
  })();
  return { addr: v4([127, 0, 0, 1], port), done, close: () => listener.close() };
}

/** Echo until EOF, then close (FIN back). */
async function echoHandler(conn: Deno.TcpConn): Promise<void> {
  const buf = new Uint8Array(4096);
  for (;;) {
    const n = await conn.read(buf);
    if (n === null) return;
    let at = 0;
    while (at < n) at += await conn.write(buf.subarray(at, n));
  }
}

/** A connected client against a fresh server running `handler`. */
async function connected(
  handler: (conn: Deno.TcpConn) => Promise<void>,
): Promise<{ socket: TcpSocket; server: TestServer }> {
  const server = tcpServer(handler);
  const socket = TcpSocket.create("ipv4");
  await socket.connect(server.addr);
  return { socket, server };
}

// --- the data path -----------------------------------------------------------

Deno.test("tcp: connect / send / receive — loopback echo, both futures ok", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    const [rx, rxDone] = socket.receive();
    // send is called once with the whole outgoing stream; its future is
    // the transmission report. Never awaited before the reads — the test
    // mirrors the guest's concurrent pumps.
    const txDone = socket.send(chunksOf([1, 2, 3], [4, 5]));
    assertEq(JSON.stringify(await collect(rx)), JSON.stringify([1, 2, 3, 4, 5]));
    assertEq((await txDone).kind, "ok");
    assertEq((await rxDone).kind, "ok");
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: addresses report the real endpoints once connected", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    const local = socket.getLocalAddress();
    assertTrue(local.kind === "ipv4" && local.value.port !== 0, "local port assigned");
    assertEq(JSON.stringify(socket.getRemoteAddress()), JSON.stringify(server.addr));
    assertEq(socket.getAddressFamily(), "ipv4");
    assertEq(socket.getIsListening(), false);
    // End the exchange so the server task retires.
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf());
    await collect(rx);
    await txDone;
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: an empty send stream is a bare FIN the peer sees as EOF", async () => {
  let sawEof = false;
  const { socket, server } = await connected(async (conn) => {
    const n = await conn.read(new Uint8Array(16));
    sawEof = n === null;
  });
  try {
    const txDone = socket.send(chunksOf());
    assertEq((await txDone).kind, "ok");
    await server.done;
    assertEq(sawEof, true, "the FIN arrived with no data before it");
  } finally {
    dispose(socket);
  }
});

// --- error contract: futures, not throws --------------------------------------

Deno.test("tcp: send before connect settles err(invalid-state), never throws", async () => {
  const socket = TcpSocket.create("ipv4");
  assertEq(resultErrKind(await socket.send(chunksOf([1]))), "invalid-state");
  dispose(socket);
});

Deno.test("tcp: send is once-only; the second future is err(invalid-state)", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    const [rx, rxDone] = socket.receive();
    const first = socket.send(chunksOf([9]));
    assertEq(resultErrKind(await socket.send(chunksOf([8]))), "invalid-state");
    assertEq(JSON.stringify(await collect(rx)), JSON.stringify([9]));
    assertEq((await first).kind, "ok");
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: receive before connect / repeated receive — closed stream + err future", async () => {
  const unconnected = TcpSocket.create("ipv4");
  const [rx0, done0] = unconnected.receive();
  assertEq(JSON.stringify(await collect(rx0)), "[]");
  assertEq(resultErrKind(await done0), "invalid-state");
  dispose(unconnected);

  const { socket, server } = await connected(echoHandler);
  try {
    const [rx1, rxDone] = socket.receive();
    const [rx2, done2] = socket.receive(); // WIT: closed stream + err(invalid-state)
    assertEq(JSON.stringify(await collect(rx2)), "[]");
    assertEq(resultErrKind(await done2), "invalid-state");
    const txDone = socket.send(chunksOf());
    await collect(rx1);
    await txDone;
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: a write on a peer-closed connection settles the send future as err", async () => {
  // The server closes without reading; the client's first write lands in
  // flight (and triggers an RST once the peer socket is gone), so a later
  // write fails. Retried writes with a pause make the RST observation
  // deterministic on loopback.
  const { socket, server } = await connected((conn) => {
    conn.close();
    return Promise.resolve();
  });
  try {
    await server.done;
    const result = await socket.send((async function* () {
      for (let i = 0; i < 50; i++) {
        yield new Uint8Array(1024);
        await new Promise((r) => setTimeout(r, 5));
      }
    })());
    assertEq(result.kind, "err");
    const kind = resultErrKind(result);
    assertTrue(
      kind === "connection-reset" || kind === "connection-broken" || kind === "invalid-state",
      `a connection-failure kind, got ${kind}`,
    );
  } finally {
    dispose(socket);
  }
});

// --- connect state machine -----------------------------------------------------

Deno.test("tcp: connect argument validation (branded)", async () => {
  const socket = TcpSocket.create("ipv4");
  const v6Socket = TcpSocket.create("ipv6");
  try {
    assertEq(await errKindAsync(socket.connect(v6([0, 0, 0, 0, 0, 0, 0, 1], 9))), "invalid-argument");
    assertEq(await errKindAsync(socket.connect(v4([0, 0, 0, 0], 9))), "invalid-argument");
    assertEq(await errKindAsync(socket.connect(v4([127, 0, 0, 1], 0))), "invalid-argument");
    assertEq(
      await errKindAsync(v6Socket.connect(v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], 9, 3))),
      "not-supported",
    );
    // An IPv4-mapped IPv6 address never crosses the family boundary.
    assertEq(
      await errKindAsync(v6Socket.connect(v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1], 9))),
      "invalid-argument",
    );
  } finally {
    dispose(socket);
    dispose(v6Socket);
  }
});

Deno.test("tcp: a refused dial closes the socket; only drop remains valid", async () => {
  // A port with no listener: bind one, note the port, close it.
  const probe = Deno.listen({ transport: "tcp", hostname: "127.0.0.1", port: 0 });
  const { port } = probe.addr as Deno.NetAddr;
  probe.close();

  const socket = TcpSocket.create("ipv4");
  assertEq(await errKindAsync(socket.connect(v4([127, 0, 0, 1], port))), "connection-refused");
  // Failed connect -> closed: connect again is invalid-state, and so is the
  // rest of the surface.
  assertEq(await errKindAsync(socket.connect(v4([127, 0, 0, 1], port))), "invalid-state");
  assertEq(resultErrKind(await socket.send(chunksOf([1]))), "invalid-state");
  assertEq(errKind(() => socket.getLocalAddress()), "invalid-state");
  dispose(socket);
});

Deno.test("tcp: connect is once-only from connected too", async () => {
  const { socket, server } = await connected(echoHandler);
  try {
    assertEq(await errKindAsync(socket.connect(server.addr)), "invalid-state");
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf());
    await collect(rx);
    await txDone;
    await rxDone;
    await server.done;
  } finally {
    dispose(socket);
  }
});

Deno.test("tcp: getters demand the right state (branded)", () => {
  const socket = TcpSocket.create("ipv4");
  assertEq(errKind(() => socket.getLocalAddress()), "invalid-state");
  assertEq(errKind(() => socket.getRemoteAddress()), "invalid-state");
  assertEq(socket.getAddressFamily(), "ipv4");
  dispose(socket);
});

Deno.test("tcp: create without Deno.connect is not-supported", () => {
  const ns = Deno as { connect?: unknown };
  const saved = ns.connect;
  ns.connect = undefined;
  try {
    assertEq(errKind(() => TcpSocket.create("ipv4")), "not-supported");
  } finally {
    ns.connect = saved;
  }
});

// --- teardown: shared ownership ------------------------------------------------

Deno.test("tcp: streams outlive the dropped handle (WIT shared ownership)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { socket, server } = await connected(async (conn) => {
    await gate; // hold the connection open until the client has dropped its handle
    await conn.write(Uint8Array.from([7]));
    // close() in the server wrapper sends the FIN.
  });
  const [rx, rxDone] = socket.receive();
  const txDone = socket.send(chunksOf());
  // Drop the guest handle FIRST: per the WIT, the send/receive streams
  // remain functional — the OS socket must survive until the pumps retire.
  dispose(socket);
  release();
  assertEq(JSON.stringify(await collect(rx)), JSON.stringify([7]));
  assertEq((await rxDone).kind, "ok");
  assertEq((await txDone).kind, "ok");
  await server.done;
});

Deno.test("tcp: dropping the receive reader settles its future ok and releases the socket", async () => {
  let stop = false;
  const { socket, server } = await connected(async (conn) => {
    // Keep offering data until the client is gone.
    while (!stop) {
      try {
        await conn.write(Uint8Array.from([1, 2, 3]));
      } catch {
        break; // client closed: expected
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  });
  try {
    const [rx, rxDone] = socket.receive();
    const it = (rx as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const first = await it.next();
    assertEq(first.done, false);
    // Guest drops the reader (SHUT_RD): queued data is discarded; the
    // future settles ok — the canceller is the observer.
    await it.return!(undefined);
    assertEq((await rxDone).kind, "ok");
  } finally {
    stop = true;
    dispose(socket);
    await server.done;
  }
});

Deno.test("tcp: dispose during connect closes the fresh conn (branded invalid-state)", async () => {
  const { addr, done } = tcpServer(() => Promise.resolve());
  const socket = TcpSocket.create("ipv4");
  const dial = socket.connect(addr);
  dispose(socket); // the dial is in flight
  assertEq(await errKindAsync(dial), "invalid-state");
  await done;
});

// --- observability -------------------------------------------------------------

Deno.test("tcp: onCall records the driving sequence", async () => {
  const calls: string[] = [];
  const fragment = sockets({ onCall: (c) => calls.push(c) });
  const { addr, done } = tcpServer(echoHandler);
  const socket = fragment.TcpSocket.create("ipv4");
  try {
    await socket.connect(addr);
    socket.getLocalAddress();
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf([1]));
    await collect(rx);
    await txDone;
    await rxDone;
    await done;
    assertEq(
      JSON.stringify(calls),
      JSON.stringify([
        "tcp-socket.create",
        "tcp-socket.connect",
        "tcp-socket.get-local-address",
        "tcp-socket.receive",
        "tcp-socket.send",
      ]),
    );
  } finally {
    dispose(socket);
  }
});
