// The node backend (sockets_platform.ts) driven in-suite: these tests
// force detection to the node adapters (`forceNodeBackendForTests` — see
// that seam's doc for why the `Deno` global cannot simply be hidden) and
// exercise the SAME provider semantics the Deno-backend tests pin — under
// Deno's node-compat `node:dgram`/`node:net`. This is the logic lane; `just test-sockets-node`
// runs the real thing (tests/node_smoke.ts under the pinned Node from
// tools/shell), so backend-specific behavior is verified on both the
// emulation and the genuine platform.
//
// The load-bearing node-backend properties covered here, beyond re-running
// the shared semantics:
//   * bind + get-local-address as a SYNC sequence (the iroh exam's exact
//     driving order) — only possible through the synchronous-lookup bind;
//   * a conflicting bind fails address-in-use SYNCHRONOUSLY (branded);
//   * dispose retires a parked receive as a branded err (the adapter's
//     ERR_SOCKET_DGRAM_NOT_RUNNING path, mirroring Deno's BadResource);
//   * TCP half-close, refused dials, and peer-closed writes map through
//     Node `err.code`s instead of Deno error classes.

import { ComponentException } from "@deltic/runtime/embedder";
import {
  type IpSocketAddress,
  type SocketErrorCode,
  type SocketResult,
  sockets,
} from "../src/sockets.ts";
import { forceNodeBackendForTests } from "../src/sockets_platform.ts";
import { assertEq, assertRejects, assertThrows, assertTrue } from "./asserts.ts";

// --- node builtins for test servers ---------------------------------------------

interface NodeTestSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  destroy(): unknown;
}

interface NodeTestServer {
  listen(port: number, host: string, cb: () => void): unknown;
  close(cb?: () => void): unknown;
  address(): { port: number };
}

interface NodeNetTestModule {
  createServer(
    options: { allowHalfOpen: boolean },
    handler: (conn: NodeTestSocket) => void,
  ): NodeTestServer;
}

const nodeNet = (process as unknown as {
  getBuiltinModule: (name: string) => unknown;
}).getBuiltinModule("node:net") as NodeNetTestModule;

/** Run `fn` with detection forced to the node backends (see the seam's doc). */
async function onNodeBackend<T>(fn: () => Promise<T>): Promise<T> {
  forceNodeBackendForTests(true);
  try {
    return await fn();
  } finally {
    forceNodeBackendForTests(false);
  }
}

const { UdpSocket, TcpSocket } = sockets();

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});

function errKind(fn: () => unknown): string {
  const e = assertThrows(fn);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<SocketErrorCode>).payload).kind;
}

async function errKindAsync(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<SocketErrorCode>).payload).kind;
}

function resultErrKind(r: SocketResult): string {
  assertEq(r.kind, "err");
  return r.kind === "err" ? r.value.kind : "";
}

async function* chunksOf(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield Uint8Array.from(c);
}

async function collect(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) out.push(...chunk);
  return out;
}

/** A one-connection node-API echo server (echoes data as it arrives; FIN on FIN). */
function nodeEchoServer(): Promise<{ addr: IpSocketAddress; close: () => Promise<void> }> {
  const server = nodeNet.createServer({ allowHalfOpen: true }, (conn) => {
    conn.on("data", (...args) => conn.write(args[0] as Uint8Array));
    conn.on("end", () => conn.end());
    conn.on("error", () => conn.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        addr: v4([127, 0, 0, 1], server.address().port),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// --- udp over node:dgram --------------------------------------------------------

Deno.test("node udp: create/bind/get-local-address as a sync sequence (the iroh driving order)", async () => {
  await onNodeBackend(async () => {
    const socket = UdpSocket.create("ipv4");
    try {
      socket.bind(v4([127, 0, 0, 1], 0));
      const addr = socket.getLocalAddress(); // same activation, no event-loop turn
      assertEq(addr.kind, "ipv4");
      assertTrue(addr.kind === "ipv4" && addr.value.port !== 0, "ephemeral port assigned");
    } finally {
      socket[Symbol.dispose]();
    }
    await Promise.resolve();
  });
});

Deno.test("node udp: datagram roundtrip with source address; zero-length self-wake", async () => {
  await onNodeBackend(async () => {
    const a = UdpSocket.create("ipv4");
    const b = UdpSocket.create("ipv4");
    try {
      a.bind(v4([127, 0, 0, 1], 0));
      b.bind(v4([127, 0, 0, 1], 0));
      const aAddr = a.getLocalAddress();
      const bAddr = b.getLocalAddress();
      await a.send(Uint8Array.from([1, 2, 3]), bAddr);
      const [payload, from] = await b.receive();
      assertEq(JSON.stringify([...payload]), JSON.stringify([1, 2, 3]));
      assertEq(JSON.stringify(from), JSON.stringify(aAddr));
      // The pump-teardown self-wake the iroh consumer depends on.
      const pending = a.receive();
      await a.send(new Uint8Array(0), aAddr);
      const [empty] = await pending;
      assertEq(empty.length, 0);
    } finally {
      a[Symbol.dispose]();
      b[Symbol.dispose]();
    }
  });
});

Deno.test("node udp: implicit bind on send", async () => {
  await onNodeBackend(async () => {
    const listener = UdpSocket.create("ipv4");
    const sender = UdpSocket.create("ipv4");
    try {
      listener.bind(v4([127, 0, 0, 1], 0));
      await sender.send(Uint8Array.from([9]), listener.getLocalAddress());
      const local = sender.getLocalAddress();
      assertTrue(local.kind === "ipv4" && local.value.port !== 0, "send bound the socket");
      const [payload] = await listener.receive();
      assertEq(JSON.stringify([...payload]), JSON.stringify([9]));
    } finally {
      sender[Symbol.dispose]();
      listener[Symbol.dispose]();
    }
  });
});

Deno.test("node udp: a conflicting bind fails address-in-use synchronously (branded)", async () => {
  await onNodeBackend(async () => {
    const first = UdpSocket.create("ipv4");
    const second = UdpSocket.create("ipv4");
    try {
      first.bind(v4([127, 0, 0, 1], 0));
      assertEq(errKind(() => second.bind(first.getLocalAddress())), "address-in-use");
    } finally {
      first[Symbol.dispose]();
      second[Symbol.dispose]();
    }
    await Promise.resolve();
  });
});

Deno.test("node udp: the datagram-too-large ceiling, both detection paths", async () => {
  await onNodeBackend(async () => {
    const socket = UdpSocket.create("ipv4");
    try {
      socket.bind(v4([127, 0, 0, 1], 0));
      const addr = socket.getLocalAddress();
      assertEq(await errKindAsync(socket.send(new Uint8Array(65536), addr)), "datagram-too-large");
      // Under the WIT ceiling, above the UDP maximum: the OS EMSGSIZE,
      // arriving as a node `err.code`.
      assertEq(await errKindAsync(socket.send(new Uint8Array(65508), addr)), "datagram-too-large");
    } finally {
      socket[Symbol.dispose]();
    }
  });
});

Deno.test("node udp: dispose retires a parked receive as a branded err", async () => {
  await onNodeBackend(async () => {
    const socket = UdpSocket.create("ipv4");
    socket.bind(v4([127, 0, 0, 1], 0));
    const pending = socket.receive();
    socket[Symbol.dispose]();
    assertEq(await errKindAsync(pending), "invalid-state");
  });
});

// --- tcp over node:net ----------------------------------------------------------

Deno.test("node tcp: connect / send / receive — loopback echo, both futures ok", async () => {
  const server = await nodeEchoServer();
  try {
    await onNodeBackend(async () => {
      const socket = TcpSocket.create("ipv4");
      try {
        await socket.connect(server.addr);
        const local = socket.getLocalAddress();
        assertTrue(local.kind === "ipv4" && local.value.port !== 0, "local port");
        assertEq(JSON.stringify(socket.getRemoteAddress()), JSON.stringify(server.addr));
        const [rx, rxDone] = socket.receive();
        const txDone = socket.send(chunksOf([1, 2, 3], [4, 5]));
        assertEq(JSON.stringify(await collect(rx)), JSON.stringify([1, 2, 3, 4, 5]));
        assertEq((await txDone).kind, "ok");
        assertEq((await rxDone).kind, "ok");
      } finally {
        socket[Symbol.dispose]();
      }
    });
  } finally {
    await server.close();
  }
});

Deno.test("node tcp: a refused dial maps ECONNREFUSED (branded); the socket closes", async () => {
  // Reserve a port with no listener, node-API side.
  const probe = await nodeEchoServer();
  await probe.close();
  await onNodeBackend(async () => {
    const socket = TcpSocket.create("ipv4");
    assertEq(await errKindAsync(socket.connect(probe.addr)), "connection-refused");
    assertEq(resultErrKind(await socket.send(chunksOf([1]))), "invalid-state");
    socket[Symbol.dispose]();
  });
});

Deno.test("node tcp: streams outlive the dropped handle (shared ownership)", async () => {
  const server = await nodeEchoServer();
  try {
    await onNodeBackend(async () => {
      const socket = TcpSocket.create("ipv4");
      await socket.connect(server.addr);
      const [rx, rxDone] = socket.receive();
      const txDone = socket.send(chunksOf([7]));
      // Drop the handle FIRST; the echo still has to arrive.
      socket[Symbol.dispose]();
      assertEq(JSON.stringify(await collect(rx)), JSON.stringify([7]));
      assertEq((await rxDone).kind, "ok");
      assertEq((await txDone).kind, "ok");
    });
  } finally {
    await server.close();
  }
});

Deno.test("node tcp: a write on a peer-closed connection settles the send future as err", async () => {
  const closer = nodeNet.createServer({ allowHalfOpen: false }, (conn) => conn.destroy());
  const addr = await new Promise<IpSocketAddress>((resolve) => {
    closer.listen(0, "127.0.0.1", () => resolve(v4([127, 0, 0, 1], closer.address().port)));
  });
  try {
    await onNodeBackend(async () => {
      const socket = TcpSocket.create("ipv4");
      try {
        await socket.connect(addr);
        const result = await socket.send((async function* () {
          for (let i = 0; i < 50; i++) {
            yield new Uint8Array(1024);
            await new Promise((r) => setTimeout(r, 5));
          }
        })());
        const kind = resultErrKind(result);
        assertTrue(
          kind === "connection-reset" || kind === "connection-broken" ||
            kind === "invalid-state",
          `a connection-failure kind, got ${kind}`,
        );
      } finally {
        socket[Symbol.dispose]();
      }
    });
  } finally {
    await new Promise<void>((r) => closer.close(() => r()));
  }
});
