// The pinned-Node smoke for the à la carte sockets fragment (`just
// test-sockets-node`): the fake-node suite (tests/sockets_node_test.ts)
// covers the adapter logic under Deno's node-compat; THIS runs the same
// load-bearing semantics on the real platform — genuine `node:dgram` /
// `node:net`, and the real detection path (no `Deno` global at all).
//
// Plain script, not Deno.test: it executes under Node. `deno bundle`
// resolves the workspace imports into one self-contained ESM file (the
// recipe body in the justfile).

import { type IpSocketAddress, type SocketResult, sockets } from "../src/sockets.ts";

function assert(cond: boolean, what: string): void {
  if (!cond) throw new Error(`FAIL: ${what}`);
}

function assertEq(got: unknown, want: unknown, what: string): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL: ${what}: got ${g}, want ${w}`);
}

function errKindOf(e: unknown): string {
  const payload = (e as { payload?: { kind?: string } })?.payload;
  if (typeof payload?.kind !== "string") {
    throw new Error(`FAIL: expected a branded socket error, got ${e}`);
  }
  return payload.kind;
}

function resultErrKind(r: SocketResult, what: string): string {
  assert(r.kind === "err", `${what}: expected err result, got ${JSON.stringify(r)}`);
  return r.kind === "err" ? r.value.kind : "";
}

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});

async function* chunksOf(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield Uint8Array.from(c);
}

async function collect(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) out.push(...chunk);
  return out;
}

// Node test servers, via the same builtin channel the backend uses.
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
const nodeNet = (globalThis as unknown as {
  process: { getBuiltinModule: (name: string) => unknown };
}).process.getBuiltinModule("node:net") as {
  createServer(
    options: { allowHalfOpen: boolean },
    handler: (conn: NodeTestSocket) => void,
  ): NodeTestServer;
};

function echoServer(): Promise<{ addr: IpSocketAddress; close: () => Promise<void> }> {
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

async function main(): Promise<void> {
  assert(
    (globalThis as { Deno?: unknown }).Deno === undefined,
    "this smoke must run on real Node (no Deno global) — the detection path under test",
  );
  const { UdpSocket, TcpSocket } = sockets();

  // --- udp: the iroh driving sequence, synchronously -------------------------
  {
    const socket = UdpSocket.create("ipv4");
    socket.bind(v4([127, 0, 0, 1], 0));
    const addr = socket.getLocalAddress(); // same tick as bind — the sync-lookup trick
    assert(addr.kind === "ipv4" && addr.value.port !== 0, "udp sync bind + get-local-address");
    socket[Symbol.dispose]();
  }

  // --- udp: roundtrip, source address, zero-length self-wake ------------------
  {
    const a = UdpSocket.create("ipv4");
    const b = UdpSocket.create("ipv4");
    a.bind(v4([127, 0, 0, 1], 0));
    b.bind(v4([127, 0, 0, 1], 0));
    await a.send(Uint8Array.from([1, 2, 3]), b.getLocalAddress());
    const [payload, from] = await b.receive();
    assertEq([...payload], [1, 2, 3], "udp roundtrip payload");
    assertEq(from, a.getLocalAddress(), "udp source address");
    const pending = a.receive();
    await a.send(new Uint8Array(0), a.getLocalAddress());
    const [empty] = await pending;
    assertEq(empty.length, 0, "udp zero-length self-wake");
    a[Symbol.dispose]();
    b[Symbol.dispose]();
  }

  // --- udp: error contract -----------------------------------------------------
  {
    const socket = UdpSocket.create("ipv4");
    socket.bind(v4([127, 0, 0, 1], 0));
    const addr = socket.getLocalAddress();
    for (const size of [65536, 65508]) {
      try {
        await socket.send(new Uint8Array(size), addr);
        assert(false, `udp oversize send (${size}) must fail`);
      } catch (e) {
        assertEq(errKindOf(e), "datagram-too-large", `udp oversize send (${size})`);
      }
    }
    const other = UdpSocket.create("ipv4");
    try {
      other.bind(addr);
      assert(false, "udp conflicting bind must fail");
    } catch (e) {
      assertEq(errKindOf(e), "address-in-use", "udp conflicting bind");
    }
    other[Symbol.dispose]();
    const parked = socket.receive();
    socket[Symbol.dispose]();
    try {
      await parked;
      assert(false, "udp parked receive must settle as err on dispose");
    } catch (e) {
      assertEq(errKindOf(e), "invalid-state", "udp dispose retires a parked receive");
    }
  }

  // --- tcp: echo, FIN semantics, futures ---------------------------------------
  {
    const server = await echoServer();
    const socket = TcpSocket.create("ipv4");
    await socket.connect(server.addr);
    assertEq(socket.getRemoteAddress(), server.addr, "tcp remote address");
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf([1, 2, 3], [4, 5]));
    assertEq(await collect(rx), [1, 2, 3, 4, 5], "tcp echo payload");
    assertEq((await txDone).kind, "ok", "tcp send future");
    assertEq((await rxDone).kind, "ok", "tcp receive future");
    socket[Symbol.dispose]();
    await server.close();
  }

  // --- tcp: shared ownership (streams outlive the dropped handle) --------------
  {
    const server = await echoServer();
    const socket = TcpSocket.create("ipv4");
    await socket.connect(server.addr);
    const [rx, rxDone] = socket.receive();
    const txDone = socket.send(chunksOf([7]));
    socket[Symbol.dispose]();
    assertEq(await collect(rx), [7], "tcp echo after handle drop");
    assertEq((await rxDone).kind, "ok", "tcp receive future after handle drop");
    assertEq((await txDone).kind, "ok", "tcp send future after handle drop");
    await server.close();
  }

  // --- tcp: refused dial --------------------------------------------------------
  {
    const probe = await echoServer();
    await probe.close();
    const socket = TcpSocket.create("ipv4");
    try {
      await socket.connect(probe.addr);
      assert(false, "tcp refused dial must fail");
    } catch (e) {
      assertEq(errKindOf(e), "connection-refused", "tcp refused dial");
    }
    assertEq(
      resultErrKind(await socket.send(chunksOf([1])), "tcp send after failed dial"),
      "invalid-state",
      "tcp send after failed dial",
    );
    socket[Symbol.dispose]();
  }

  // --- tcp: peer-closed write settles the send future as err -------------------
  {
    const closer = nodeNet.createServer({ allowHalfOpen: false }, (conn) => conn.destroy());
    const addr = await new Promise<IpSocketAddress>((resolve) => {
      closer.listen(0, "127.0.0.1", () => resolve(v4([127, 0, 0, 1], closer.address().port)));
    });
    const socket = TcpSocket.create("ipv4");
    await socket.connect(addr);
    const result = await socket.send((async function* () {
      for (let i = 0; i < 50; i++) {
        yield new Uint8Array(1024);
        await new Promise((r) => setTimeout(r, 5));
      }
    })());
    const kind = resultErrKind(result, "tcp peer-closed write");
    assert(
      kind === "connection-reset" || kind === "connection-broken" || kind === "invalid-state",
      `tcp peer-closed write: a connection-failure kind, got ${kind}`,
    );
    socket[Symbol.dispose]();
    await new Promise<void>((r) => closer.close(() => r()));
  }

  const version = (globalThis as unknown as { process: { version: string } }).process.version;
  console.log(`sockets node smoke: OK (udp + tcp on ${version})`);
}

main().catch((e) => {
  console.error(String((e as Error)?.stack ?? e));
  (globalThis as unknown as { process: { exit: (code: number) => void } }).process.exit(1);
});
