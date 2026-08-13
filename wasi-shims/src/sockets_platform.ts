// The platform seam under `sockets.ts`: the connection shapes the
// providers drive (`DatagramConn`, `TcpConn`, `TcpListener`), served by
// ONE backend — the node builtins (`node:dgram` / `node:net`), resolved
// through `process.getBuiltinModule` (synchronous, Node >= 20.16 / 22.3;
// no static `node:` imports, so the module graph stays bundler- and
// browser-safe).
//
// Why node builtins EVERYWHERE, including on Deno (a deliberate reversal
// of the earlier native-first split, with better reasoning):
//
//   * Deno ships these builtins as STABLE node-compat surface. Its own
//     `Deno.listenDatagram` sits behind `--unstable-net`, but that flag
//     gates the native API's SHAPE stability, not the capability — so
//     the old backend told stock-Deno consumers "UDP not-supported"
//     while the platform's stable surface could serve it. One backend
//     drops the `--unstable-net` requirement entirely.
//   * One behavior on every runtime: one divergence table, one test
//     matrix (the whole provider suite exercises this path under Deno's
//     compat; `just test-sockets-node` re-runs it on genuine Node).
//   * `net.connect` exposes `localAddress`/`localPort`, so
//     connect-from-bound works — the native `Deno.connect` never could.
//   * The engines where node builtins do not exist and JSPI is absent
//     (JSC, and Bun atop it) cannot run deltic guests anyway: JSC lacks
//     multi-memory. Browsers have no sockets of any flavor.
//
// Costs, measured and accepted:
//   * ~2x per-operation overhead on a UDP loopback ping-pong microbench
//     vs the native API (~105k vs ~158k pkt/s round-trips under Deno) —
//     far above what the QUIC consumers draw, and the CM boundary
//     dominates real flows.
//   * Permission denials arrive as genuine `Deno.errors.NotCapable`
//     instances through the compat layer (verified) — the provider's
//     error mapper keeps its Deno-class checks for exactly this.
//
// Node adapter notes (each verified empirically on pinned node 26.7.0,
// system node 24, and Deno's node-compat):
//
//   * dgram bind is made SYNCHRONOUS by giving `createSocket` a custom
//     `lookup` whose callback fires synchronously (addresses here are
//     always numeric, so there is nothing to resolve). The WIT `bind` and
//     `get-local-address` are sync funcs; with the default async lookup,
//     `address()` right after `bind()` throws EBADF and bind errors only
//     surface on a later tick. With the sync lookup, `address()` is valid
//     on return and EADDRINUSE throws at the bind call site.
//   * `net.Server.listen` has NO such escape hatch: with a specific host
//     the OS bind is DEFERRED one event-loop turn (`'listening'` /
//     `'error'` arrive later). The seam exposes that settle as
//     `TcpListener.settled()`; the provider awaits it inside a
//     `suspending`-marked `listen`, parking the calling guest frame for
//     the one tick (embedder-api A1/A2 — the same kernel that serves
//     wasi:io's sync `block`). Full listener fidelity follows: real
//     ephemeral addresses, real bind error codes.
//   * dgram receive is push-shaped (`'message'` events); the adapter
//     bridges to the seam's pull shape with a BOUNDED queue
//     (tail-drop past `MAX_QUEUED_DATAGRAMS` — kernel-buffer semantics:
//     UDP is lossy by contract, and a guest that stops reading must not
//     grow host memory without bound).
//   * `net.connect` gets `allowHalfOpen: true` — Node's default auto-ends
//     the write side on peer FIN, which would break the WIT's
//     shared-ownership/half-close contract (the send stream must remain
//     usable after the receive side ends).
//   * TCP reads pull via `'readable'` + `read()`, handing node's own
//     buffers through (zero extra copy); the excess past the caller's
//     `max` is `unshift()`ed back.
//
// The adapters throw RAW platform errors (node `code`-carrying errors,
// and `Deno.errors.NotCapable` where the compat layer raises it); mapping
// onto the WIT `error-code` vocabulary stays with the providers
// (`sockets.ts` `mapPlatformError`), so this module has no imports at
// all. Everything is looked up through `globalThis` at call time — the
// module never assumes a platform at evaluation, and `create` can answer
// `not-supported` truthfully on hosts with no node builtins (browsers).

/** The address shape the socket backends speak. */
export interface NetAddr {
  transport?: string;
  hostname: string;
  port: number;
}

/** The bound-datagram-socket seam. */
export interface DatagramConn {
  readonly addr: NetAddr;
  send(p: Uint8Array, addr: NetAddr): Promise<number>;
  receive(): Promise<[Uint8Array, NetAddr]>;
  close(): void;
}

export type ListenDatagram = (options: {
  transport: "udp";
  hostname: string;
  port: number;
}) => DatagramConn;

/** The connected-TCP-socket seam. */
export interface TcpConn {
  readonly localAddr: NetAddr;
  readonly remoteAddr: NetAddr;
  /** Up to `max` bytes (node's own buffer, no copy); `null` = peer FIN. */
  read(max: number): Promise<Uint8Array | null>;
  write(p: Uint8Array): Promise<number>;
  closeWrite(): Promise<void>;
  close(): void;
}

export type TcpConnect = (options: {
  transport: "tcp";
  hostname: string;
  port: number;
  /** Source binding (connect-from-bound); both or neither. */
  localHostname?: string;
  localPort?: number;
}) => Promise<TcpConn>;

/**
 * The listening-TCP-socket seam. The OS bind is deferred (module header):
 * `settled()` resolves once the listener is live (rejects with the bind
 * failure), after which `addr` is non-null.
 */
export interface TcpListener {
  readonly addr: NetAddr | null;
  settled(): Promise<void>;
  accept(): Promise<TcpConn>;
  close(): void;
}

export type TcpListen = (options: {
  transport: "tcp";
  hostname: string;
  port: number;
}) => TcpListener;

// --- detection ----------------------------------------------------------------

/** `process.getBuiltinModule(name)`, if this host has it (Node, Deno, Bun). */
function nodeBuiltin(name: string): unknown {
  const proc = (globalThis as {
    process?: { getBuiltinModule?: (name: string) => unknown };
  }).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== "function") return undefined;
  try {
    return get.call(proc, name);
  } catch {
    return undefined;
  }
}

/** The datagram backend, re-detected per call. */
export function listenDatagram(): ListenDatagram | undefined {
  return nodeListenDatagram();
}

/** The TCP-connect backend, re-detected per call. */
export function tcpConnect(): TcpConnect | undefined {
  return nodeTcpConnect();
}

/** The TCP-listen backend, re-detected per call. */
export function tcpListen(): TcpListen | undefined {
  return nodeTcpListen();
}

// --- the node:dgram backend -----------------------------------------------------

/**
 * Queued-but-unread datagrams past this bound are dropped (tail-drop, the
 * kernel-buffer analogue). Node's `'message'` push keeps delivering
 * whether or not the guest reads; unread datagrams must not accumulate
 * without bound.
 */
export const MAX_QUEUED_DATAGRAMS = 256;

interface NodeUdpSocket {
  bind(port: number, address: string): void;
  address(): { address: string; port: number };
  send(
    msg: Uint8Array,
    port: number,
    address: string,
    cb: (err: Error | null) => void,
  ): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface NodeDgramModule {
  createSocket(options: {
    type: "udp4" | "udp6";
    lookup: (
      hostname: string,
      options: unknown,
      cb: (err: Error | null, address: string, family: number) => void,
    ) => void;
  }): NodeUdpSocket;
}

interface NodeNetModule {
  isIP(input: string): number;
  connect(options: {
    host: string;
    port: number;
    allowHalfOpen: boolean;
    localAddress?: string;
    localPort?: number;
  }): NodeTcpSocket;
  createServer(
    options: { allowHalfOpen: boolean },
    handler: (socket: NodeTcpSocket) => void,
  ): NodeTcpServer;
}

function nodeListenDatagram(): ListenDatagram | undefined {
  const dgram = nodeBuiltin("node:dgram") as NodeDgramModule | undefined;
  const net = nodeBuiltin("node:net") as NodeNetModule | undefined;
  if (dgram === undefined || net === undefined) return undefined;
  return ({ hostname, port }) => {
    const socket = dgram.createSocket({
      type: hostname.includes(":") ? "udp6" : "udp4",
      // The synchronous-lookup trick (module header): makes bind()
      // complete synchronously for numeric addresses.
      lookup: (addr, _options, cb) => cb(null, addr, net.isIP(addr)),
    });
    try {
      socket.bind(port, hostname);
    } catch (e) {
      try {
        socket.close();
      } catch {
        // Never came up.
      }
      throw e;
    }
    return new NodeDatagramConn(socket);
  };
}

/** A plain Error carrying a Node-style `code` (for the provider's mapper). */
function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

class NodeDatagramConn implements DatagramConn {
  readonly addr: NetAddr;
  #socket: NodeUdpSocket;
  #queue: [Uint8Array, NetAddr][] = [];
  #waiters: {
    resolve: (v: [Uint8Array, NetAddr]) => void;
    reject: (e: unknown) => void;
  }[] = [];
  #failure: unknown;
  #closed = false;

  constructor(socket: NodeUdpSocket) {
    this.#socket = socket;
    const a = socket.address();
    this.addr = { transport: "udp", hostname: a.address, port: a.port };
    socket.on("message", (...args: unknown[]) => {
      const msg = args[0] as Uint8Array;
      const rinfo = args[1] as { address: string; port: number };
      const from: NetAddr = {
        transport: "udp",
        hostname: rinfo.address,
        port: rinfo.port,
      };
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve([msg, from]);
        return;
      }
      if (this.#closed || this.#queue.length >= MAX_QUEUED_DATAGRAMS) return; // tail-drop
      this.#queue.push([msg, from]);
    });
    socket.on("error", (...args: unknown[]) => {
      this.#failure = args[0];
      this.#failWaiters(args[0]);
    });
  }

  #failWaiters(e: unknown): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w.reject(e);
  }

  send(p: Uint8Array, addr: NetAddr): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (this.#closed) {
        reject(codedError("ERR_SOCKET_DGRAM_NOT_RUNNING", "socket is closed"));
        return;
      }
      this.#socket.send(
        p,
        addr.port,
        addr.hostname,
        (err) => err !== null ? reject(err) : resolve(p.length),
      );
    });
  }

  receive(): Promise<[Uint8Array, NetAddr]> {
    // Node hands each datagram as its own exactly-sized buffer, passed
    // through directly.
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) {
      return Promise.reject(
        codedError("ERR_SOCKET_DGRAM_NOT_RUNNING", "socket is closed"),
      );
    }
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // A parked receive settles as an error mapping onto `invalid-state`.
    this.#failWaiters(
      codedError("ERR_SOCKET_DGRAM_NOT_RUNNING", "socket closed under a pending receive"),
    );
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
  }
}

// --- the node:net backend --------------------------------------------------------

interface NodeTcpSocket {
  readonly localAddress?: string;
  readonly localPort?: number;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly readableEnded: boolean;
  readonly destroyed: boolean;
  read(): Uint8Array | null;
  unshift(chunk: Uint8Array): void;
  write(chunk: Uint8Array, cb: (err?: Error | null) => void): boolean;
  end(cb?: () => void): unknown;
  destroy(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

function nodeTcpConnect(): TcpConnect | undefined {
  const net = nodeBuiltin("node:net") as NodeNetModule | undefined;
  if (net === undefined) return undefined;
  return async ({ hostname, port, localHostname, localPort }) => {
    // allowHalfOpen is load-bearing (module header): the WIT half-close
    // contract needs the write side to survive the peer's FIN.
    const socket = net.connect({
      host: hostname,
      port,
      allowHalfOpen: true,
      ...(localHostname === undefined ? {} : {
        localAddress: localHostname,
        localPort: localPort ?? 0,
      }),
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (...args: unknown[]) => reject(args[0]);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve();
      });
    });
    return new NodeTcpConn(socket);
  };
}

class NodeTcpConn implements TcpConn {
  readonly localAddr: NetAddr;
  readonly remoteAddr: NetAddr;
  #socket: NodeTcpSocket;
  #failure: unknown;
  #ended = false;

  constructor(socket: NodeTcpSocket) {
    this.#socket = socket;
    this.localAddr = {
      transport: "tcp",
      hostname: socket.localAddress ?? "",
      port: socket.localPort ?? 0,
    };
    this.remoteAddr = {
      transport: "tcp",
      hostname: socket.remoteAddress ?? "",
      port: socket.remotePort ?? 0,
    };
    // A persistent listener: an unhandled 'error' event would throw
    // process-wide. In-flight reads observe #failure; writes get the
    // error through their own callbacks.
    socket.on("error", (...args: unknown[]) => {
      this.#failure = args[0];
    });
    socket.on("end", () => {
      this.#ended = true;
    });
  }

  async read(max: number): Promise<Uint8Array | null> {
    for (;;) {
      if (this.#failure !== undefined) throw this.#failure;
      const chunk = this.#socket.read();
      if (chunk !== null) {
        if (chunk.length > max) {
          this.#socket.unshift(chunk.subarray(max));
          return chunk.subarray(0, max);
        }
        return chunk;
      }
      if (this.#ended || this.#socket.readableEnded) return null; // peer FIN
      if (this.#socket.destroyed) {
        // Locally destroyed under a pending read: never a fake EOS — maps
        // onto invalid-state.
        throw codedError("ERR_STREAM_DESTROYED", "socket closed under a pending read");
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          this.#socket.off("readable", done);
          this.#socket.off("end", done);
          this.#socket.off("error", done);
          this.#socket.off("close", done);
          resolve();
        };
        this.#socket.once("readable", done);
        this.#socket.once("end", done);
        this.#socket.once("error", done);
        this.#socket.once("close", done);
      });
    }
  }

  write(p: Uint8Array): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      try {
        // The callback fires once the chunk is handed to the kernel —
        // awaiting it per-write is the backpressure.
        this.#socket.write(p, (err) => {
          if (err !== null && err !== undefined) reject(err);
          else resolve(p.length);
        });
      } catch (e) {
        // write() itself throws after end()/destroy() (ERR_STREAM_*).
        reject(e);
      }
    });
  }

  closeWrite(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#socket.end(resolve);
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

// --- the node:net listener --------------------------------------------------------

/**
 * Accepted-but-unread connections past this bound are REFUSED (destroyed)
 * — node's `'connection'` push keeps accepting whether or not the guest
 * reads the accept stream, and unlike datagrams an accepted connection is
 * a live socket, so tail-drop here means an active refusal rather than a
 * silent discard (the polymorph-iroh#56 stance).
 */
export const MAX_QUEUED_CONNECTIONS = 64;

interface NodeTcpServer {
  listen(options: { port: number; host: string }): unknown;
  address(): { address: string; port: number } | null;
  close(cb?: () => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

function nodeTcpListen(): TcpListen | undefined {
  const net = nodeBuiltin("node:net") as NodeNetModule | undefined;
  if (net === undefined) return undefined;
  return ({ hostname, port }) => {
    const queue: NodeTcpSocket[] = [];
    const waiters: {
      resolve: (c: TcpConn) => void;
      reject: (e: unknown) => void;
    }[] = [];
    let failure: unknown;
    let closed = false;

    const failWaiters = (e: unknown): void => {
      const w = waiters.splice(0, waiters.length);
      for (const waiter of w) waiter.reject(e);
    };

    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(new NodeTcpConn(socket));
        return;
      }
      if (closed || queue.length >= MAX_QUEUED_CONNECTIONS) {
        socket.destroy(); // refuse: nobody is going to take it
        return;
      }
      queue.push(socket);
    });
    // The deferred OS bind (module header): 'listening' or 'error' arrive
    // one tick after listen(). `settled` is created eagerly (with a no-op
    // catch so an unobserved rejection cannot escape) and the provider
    // awaits it inside its suspending `listen`.
    let settle!: () => void;
    let fail!: (e: unknown) => void;
    const settledOnce = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    settledOnce.catch(() => {
      // Observed via settled(); this guard only prevents an unhandled
      // rejection if the provider never gets the chance.
    });
    server.on("listening", () => settle());
    server.on("error", (...args: unknown[]) => {
      failure = args[0];
      fail(args[0]);
      failWaiters(args[0]);
    });
    server.listen({ port, host: hostname });

    return {
      get addr(): NetAddr | null {
        const a = server.address();
        return a === null
          ? null
          : { transport: "tcp", hostname: a.address, port: a.port };
      },
      settled(): Promise<void> {
        return settledOnce;
      },
      accept(): Promise<TcpConn> {
        if (failure !== undefined) return Promise.reject(failure);
        if (closed) {
          return Promise.reject(
            codedError("ERR_SERVER_NOT_RUNNING", "listener is closed"),
          );
        }
        const queued = queue.shift();
        if (queued !== undefined) {
          return Promise.resolve(new NodeTcpConn(queued));
        }
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      close(): void {
        if (closed) return;
        closed = true;
        failWaiters(
          codedError("ERR_SERVER_NOT_RUNNING", "listener closed under a pending accept"),
        );
        for (const socket of queue.splice(0, queue.length)) {
          socket.destroy(); // refuse queued-but-untaken connections
        }
        try {
          server.close();
        } catch {
          // Never listening.
        }
      },
    };
  };
}
