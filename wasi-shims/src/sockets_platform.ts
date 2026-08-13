// The platform seam under `sockets.ts`: the two connection shapes the
// providers drive (`DatagramConn`, `TcpConn`), typed structurally, plus
// the per-call backend detection that picks who serves them.
//
// Two backends:
//
//   * **Deno native** — `Deno.listenDatagram` (unstable: `--unstable-net`)
//     and `Deno.connect` (stable). Used whenever a `Deno` global exists.
//     Deliberately the ONLY path on Deno: Deno gates datagram support
//     behind its unstable flag, and routing around that gate through
//     Deno's own node-compat layer would betray the honest capability
//     answer (`create` -> `not-supported` without the flag).
//   * **Node builtins** — `node:dgram` / `node:net`, resolved through
//     `process.getBuiltinModule` (synchronous, Node >= 20.16 / 22.3; no
//     static `node:` imports, so the module graph stays bundler- and
//     browser-safe). Used when there is no `Deno` global: real Node, and
//     Bun via its node-builtin compat (findings-only, as everywhere).
//
// Everything is looked up through `globalThis` at call time — the module
// never assumes a platform at evaluation, and `create` can answer
// `not-supported` truthfully on hosts with neither backend (browsers).
//
// The adapters throw RAW platform errors (Deno error classes, Node
// `code`-carrying errors); mapping onto the WIT `error-code` vocabulary
// stays with the providers (`sockets.ts` `mapPlatformError`), so this
// module has no imports at all.
//
// Node adapter notes (each verified empirically on pinned node 26.7.0,
// system node 24, and Deno's node-compat — the fake-node test lane):
//
//   * dgram bind is made SYNCHRONOUS by giving `createSocket` a custom
//     `lookup` whose callback fires synchronously (addresses here are
//     always numeric, so there is nothing to resolve). The WIT `bind` and
//     `get-local-address` are sync funcs; with the default async lookup,
//     `address()` right after `bind()` throws EBADF and bind errors only
//     surface on a later tick. With the sync lookup, `address()` is valid
//     on return and EADDRINUSE throws at the bind call site.
//   * dgram receive is push-shaped (`'message'` events); the adapter
//     bridges to the seam's pull shape with a BOUNDED queue
//     (tail-drop past `MAX_QUEUED_DATAGRAMS` — kernel-buffer semantics:
//     UDP is lossy by contract, and a guest that stops reading must not
//     grow host memory without bound).
//   * `net.connect` gets `allowHalfOpen: true` — Node's default auto-ends
//     the write side on peer FIN, which would break the WIT's
//     shared-ownership/half-close contract (the send stream must remain
//     usable after the receive side ends).
//   * TCP reads pull via `'readable'` + `read()`, with `unshift()` for
//     the excess past the caller's buffer (one copy into the caller's
//     buffer; the Deno path keeps its zero-extra-copy reads).

/** The address shape the socket backends speak (structural `Deno.NetAddr`). */
export interface NetAddr {
  transport?: string;
  hostname: string;
  port: number;
}

/** The bound-datagram-socket seam (structural `Deno.DatagramConn`). */
export interface DatagramConn {
  readonly addr: NetAddr;
  send(p: Uint8Array, addr: NetAddr): Promise<number>;
  receive(p?: Uint8Array): Promise<[Uint8Array, NetAddr]>;
  close(): void;
}

export type ListenDatagram = (options: {
  transport: "udp";
  hostname: string;
  port: number;
}) => DatagramConn;

/** The connected-TCP-socket seam (structural `Deno.TcpConn` slice). */
export interface TcpConn {
  readonly localAddr: NetAddr;
  readonly remoteAddr: NetAddr;
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  closeWrite(): Promise<void>;
  close(): void;
}

export type TcpConnect = (options: {
  transport: "tcp";
  hostname: string;
  port: number;
}) => Promise<TcpConn>;

/**
 * The listening-TCP-socket seam. `addr` is `null` while the OS bind is
 * still pending — the node backend's `server.listen` defers the bind for
 * any specific host (there is no synchronous-lookup escape hatch on
 * `net.Server`, unlike dgram), so the local address is unknowable until
 * the `'listening'` event; the Deno backend binds synchronously and never
 * reports `null`.
 */
export interface TcpListener {
  readonly addr: NetAddr | null;
  accept(): Promise<TcpConn>;
  close(): void;
}

export type TcpListen = (options: {
  transport: "tcp";
  hostname: string;
  port: number;
}) => TcpListener;

// --- detection ----------------------------------------------------------------

/**
 * @internal Test seam: route detection to the node backends even when a
 * `Deno` global exists. The fake-node test lane
 * (tests/sockets_node_test.ts) exercises the node adapters under Deno's
 * node-compat; hiding the `Deno` global instead would break that compat
 * layer itself (its internals reference the global — verified: udp_wrap
 * throws `ReferenceError: Deno is not defined`). Real no-`Deno`-global
 * detection is covered by the pinned-Node smoke (`just
 * test-sockets-node`). Never set outside tests.
 */
export function forceNodeBackendForTests(force: boolean): void {
  forcedNodeBackend = force;
}
let forcedNodeBackend = false;

function denoNamespace(): Record<string, unknown> | undefined {
  const deno = (globalThis as { Deno?: unknown }).Deno;
  return typeof deno === "object" && deno !== null
    ? (deno as Record<string, unknown>)
    : undefined;
}

/** `process.getBuiltinModule(name)`, if this host has it (Node, Bun). */
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

/** The active datagram backend, re-detected per call. */
export function listenDatagram(): ListenDatagram | undefined {
  if (!forcedNodeBackend) {
    const deno = denoNamespace();
    if (deno !== undefined) {
      const fn = deno.listenDatagram;
      return typeof fn === "function" ? (fn as ListenDatagram) : undefined;
    }
  }
  return nodeListenDatagram();
}

/** The active TCP-connect backend, re-detected per call. */
export function tcpConnect(): TcpConnect | undefined {
  if (!forcedNodeBackend) {
    const deno = denoNamespace();
    if (deno !== undefined) {
      const fn = deno.connect;
      return typeof fn === "function" ? (fn as TcpConnect) : undefined;
    }
  }
  return nodeTcpConnect();
}

/** The active TCP-listen backend, re-detected per call. */
export function tcpListen(): TcpListen | undefined {
  if (!forcedNodeBackend) {
    const deno = denoNamespace();
    if (deno !== undefined) {
      const fn = deno.listen;
      if (typeof fn !== "function") return undefined;
      // `Deno.listen` returns a `Deno.Listener` whose `addr`/`accept`/
      // `close` already satisfy the seam; the accepted conns satisfy
      // `TcpConn` the same way `Deno.connect`'s do.
      return (options) =>
        (fn as (o: typeof options) => TcpListener)(options);
    }
  }
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
  }): NodeTcpSocket;
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
      if (this.#queue.length >= MAX_QUEUED_DATAGRAMS) return; // tail-drop
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

  receive(_p?: Uint8Array): Promise<[Uint8Array, NetAddr]> {
    // The seam's optional buffer is a Deno affordance; node hands each
    // datagram as its own exactly-sized Buffer, passed through directly.
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
    // A parked receive settles as an error, mirroring Deno's BadResource
    // (the provider maps both onto `invalid-state`).
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
  return async ({ hostname, port }) => {
    // allowHalfOpen is load-bearing (module header): the WIT half-close
    // contract needs the write side to survive the peer's FIN.
    const socket = net.connect({ host: hostname, port, allowHalfOpen: true });
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

  async read(p: Uint8Array): Promise<number | null> {
    for (;;) {
      if (this.#failure !== undefined) throw this.#failure;
      const chunk = this.#socket.read();
      if (chunk !== null) {
        if (chunk.length > p.length) {
          this.#socket.unshift(chunk.subarray(p.length));
          p.set(chunk.subarray(0, p.length));
          return p.length;
        }
        p.set(chunk);
        return chunk.length;
      }
      if (this.#ended || this.#socket.readableEnded) return null; // peer FIN
      if (this.#socket.destroyed) {
        // Locally destroyed under a pending read: never a fake EOS — the
        // Deno path throws BadResource here; both map to invalid-state.
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

interface NodeNetServerModule {
  createServer(
    options: { allowHalfOpen: boolean },
    handler: (socket: NodeTcpSocket) => void,
  ): NodeTcpServer;
}

function nodeTcpListen(): TcpListen | undefined {
  const net = nodeBuiltin("node:net") as NodeNetServerModule | undefined;
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
    server.on("error", (...args: unknown[]) => {
      // Server-level errors are fatal: with a specific host the bind is
      // DEFERRED on node (module header), so this is also where a
      // deferred EADDRINUSE lands.
      failure = args[0];
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
