// `wasi:sockets` — BOTH tracks: `types@0.3` (UDP and TCP, client +
// listener; this file) and the poll-shaped `@0.2` surface (sockets_02.ts,
// registered by `sockets()` alongside). One backend serves both: the
// node builtins (`node:dgram` / `node:net`), which
// real Node provides natively, Deno serves as STABLE node-compat (no
// `--unstable-net` needed — that flag gates only the native API's shape,
// not the capability), and Bun reaches through its compat (findings-only;
// JSC lacks multi-memory, so deltic guests cannot run there regardless).
// Backend rationale, adapters, and measured costs: sockets_platform.ts.
//
// À la carte (issue #4): this module is a separate export
// (`@deltic/wasi/sockets`), never merged into `wasi()` — the
// baseline package stays host-agnostic web-platform code, while this
// fragment is server-JS-native by nature (browsers have no sockets;
// wasmtime owns the native story). Consumers that want it spread it in:
//
//   instantiate(artifacts, { ...wasi(), ...sockets().imports })
//
// The UDP provider is adopted from polymorph-components/polymorph-iroh#69
// (that host's exam drives it over loopback QUIC); divergences from the
// adopted code are the track key (`@0.3`, per this package's conventions —
// one provider serves every 0.3.x), the fragment-scoped `onCall` hook
// replacing a module-global call log (a published provider must not grow a
// string per datagram by default), and `globalThis`-based feature detection
// (the module evaluates and answers honestly on any host). The TCP client
// surface is what the wosh listener bridges through (its
// `listener-core/src/tcp.rs` — issue #4's prospective consumer) and the
// smoke-c0 leg-4 composed-websocket shopping list names.
//
// The implemented resource shapes (0.3.x WIT — the full 0.3.1 release
// surface, minus the recorded not-supported options below):
//
//   resource udp-socket {
//     create/bind/connect/disconnect/send/receive,
//     get-local-address/get-remote-address/get-address-family,
//     get+set unicast-hop-limit, get+set receive/send-buffer-size
//   }
//   resource tcp-socket {
//     create/bind/connect/listen/send/receive,
//     get-local-address/get-remote-address/get-address-family/get-is-listening,
//     set-listen-backlog-size, get+set keep-alive-enabled,
//     get+set keep-alive-idle-time
//   }
//   ip-name-lookup { resolve-addresses }  (system resolver via node:dns)
//
// OPTIONS HONESTY (the node option surface is narrow; nothing is
// emulated silently):
//
//   * udp connect/disconnect are OS-level (node dgram connect: kernel
//     filtering and default destination), not adapter filtering.
//   * udp unicast-hop-limit: setter is real (dgram setTTL); the getter
//     reports the cached value (default 64, documented) — node has no
//     getter. Buffer sizes are real both ways once bound (SO_RCVBUF/
//     SO_SNDBUF); before bind, gets report the cached request or fail
//     `not-supported`.
//   * tcp keep-alive: enabled + idle-time are real (node setKeepAlive);
//     gets report cached values (idle default 7200 s, documented).
//     keep-alive-interval/count, tcp hop-limit, and tcp buffer sizes
//     have NO node:net API and fail `not-supported`.
//   * set-listen-backlog-size: applied as listen()'s backlog hint;
//     changing it while listening is `not-supported` (node cannot
//     re-listen; wasmtime re-listens).
//   * accepted sockets do NOT inherit the listener's options (wasmtime
//     inherits; recorded divergence).
//
// Anything else a future guest links fails loudly with a trap naming the
// missing method rather than riding an untested emulation.
//
// The behavioral yardstick is wasmtime-wasi's p3 provider (the consumers'
// wasmtime hosts serve the same guests through it).
//
// UDP: the same 64 KiB datagram ceiling, the same state machine (`bind`
// once from unbound; `receive` and `get-local-address` demand a bound
// socket; `send` to a remote implicitly binds an unbound socket to a
// wildcard address; an omitted `send` remote requires connected mode, and
// an explicit remote on a connected socket is `invalid-argument`), and the same address-family validation (an
// IPv4-mapped or deprecated IPv4-compatible IPv6 address never crosses a
// family boundary). Recorded divergences, rooted in the platform exposing
// no socket options:
//
//   * scope-id: a non-zero IPv6 `scope-id` fails `not-supported` (node
//     hostnames cannot carry a zone; wasmtime binds it).
//   * v6-only: wasmtime sets IPV6_V6ONLY on IPv6 sockets; node leaves the
//     OS default, so an `::` wildcard bind on Linux is dual-stack and may
//     receive IPv4 traffic, surfaced as IPv4-mapped sender addresses —
//     which is also why the address codec parses the `::ffff:a.b.c.d`
//     spelling.
//   * unread datagrams queue in the adapter (node's receive path is
//     push-shaped) and tail-drop past a bound — the kernel-buffer
//     analogue; see sockets_platform.ts `MAX_QUEUED_DATAGRAMS`.
//
// TCP (the TcpSocketOperationalSemantics-0.3.0 state machine): `connect`
// once from `unbound` (a failed attempt closes the socket); `listen` once
// from `unbound` (implicit wildcard-ephemeral bind) or `bound`;
// `send`/`receive` once each, only when `connected`, and their failures
// NEVER throw — `send`'s error channel is its returned future (amendment
// A12: the async method's promise IS the future source) and `receive`'s
// is the future half of its tuple, resolved as result values. `listen`
// returns the perpetual accept stream, whose elements are connected
// `tcp-socket` resources (amendment A13: un-taken elements are destroyed
// at teardown, closing their connections); per-connection accept failures
// are skipped, listener-fatal ones end the stream. Stream teardown
// follows the WIT's shared-ownership note: the OS socket closes only when
// the resource handle AND every derived stream (pumps, accept stream) are
// done, so they all remain functional after the guest drops the
// `tcp-socket` handle. The receive stream ends (cleanly, no fake data) on
// BOTH graceful FIN and abnormal close; the two are distinguished by the
// future (`ok` vs `err`), exactly as the WIT documents. Guest-side
// failures while consuming `send`'s stream (a peer trap) are NOT socket
// errors: they propagate as producer failures on the host-failure channel.
//
// `listen` is SUSPENDING (embedder-api A1/A2 — the wasi:io `block`
// kernel): node defers the OS bind one event-loop turn, so `listen` parks
// the calling guest frame for that tick and returns fully settled — real
// ephemeral addresses from `get-local-address`, real error codes
// (`address-in-use`) from a failed bind. Guests that link `listen`
// auto-select jspi mode on JSPI engines (V8: Deno, Node, Chromium);
// client-shaped guests are untouched.
//
// Recorded TCP divergences:
//
//   * `bind` records the address; the OS bind is DEFERRED to `listen` or
//     `connect` (node cannot bind an unconnected socket), so bind errors
//     (`address-in-use`, `address-not-bindable`) surface at those calls —
//     with their real codes — not at `bind`.
//
// When the node builtins are absent (`process.getBuiltinModule` missing —
// a browser), `create` fails `error-code.not-supported` — the honest
// capability answer. On Deno the providers need `--allow-net`; a denied
// permission arrives as `Deno.errors.NotCapable` through the compat layer
// and maps to `access-denied`.

import { ComponentException, Stream, suspending } from "@deltic/runtime/embedder";
// The @0.2 track (poll-shaped two-phase surface) lives in sockets_02.ts;
// `sockets()` registers both tracks. The import is cyclic on purpose —
// sockets_02 consumes this module's codec/validators, which are hoisted
// function declarations, so evaluation order is safe.
import { sockets02 } from "./sockets_02.ts";

/** `wasi:sockets/types@0.3`'s `ip-address-family` enum. */
export type IpAddressFamily = "ipv4" | "ipv6";

/** `ipv4-address` = `tuple<u8, u8, u8, u8>`. */
export type Ipv4Address = [number, number, number, number];

/** `ipv6-address` = `tuple<u16 × 8>`. */
export type Ipv6Address = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface Ipv4SocketAddress {
  port: number;
  address: Ipv4Address;
}

export interface Ipv6SocketAddress {
  port: number;
  flowInfo: number;
  address: Ipv6Address;
  scopeId: number;
}

/** The `ip-socket-address` variant, in `{ kind, value }` form (A10). */
export type IpSocketAddress =
  | { kind: "ipv4"; value: Ipv4SocketAddress }
  | { kind: "ipv6"; value: Ipv6SocketAddress };

/** The address-only `ip-address` variant (ip-name-lookup's vocabulary). */
export type IpAddress =
  | { kind: "ipv4"; value: Ipv4Address }
  | { kind: "ipv6"; value: Ipv6Address };

/** `wasi:sockets/ip-name-lookup@0.3`'s own `error-code` variant. */
export type NameLookupErrorCode =
  | { kind: "access-denied" }
  | { kind: "invalid-argument" }
  | { kind: "name-unresolvable" }
  | { kind: "temporary-resolver-failure" }
  | { kind: "permanent-resolver-failure" }
  | { kind: "other"; value?: string };

/**
 * The `error-code` variant. Every case is listed so callers can switch
 * exhaustively against the real WIT vocabulary.
 */
export type SocketErrorCode =
  | { kind: "access-denied" }
  | { kind: "not-supported" }
  | { kind: "invalid-argument" }
  | { kind: "out-of-memory" }
  | { kind: "timeout" }
  | { kind: "invalid-state" }
  | { kind: "address-not-bindable" }
  | { kind: "address-in-use" }
  | { kind: "remote-unreachable" }
  | { kind: "connection-refused" }
  | { kind: "connection-broken" }
  | { kind: "connection-reset" }
  | { kind: "connection-aborted" }
  | { kind: "datagram-too-large" }
  | { kind: "other"; value?: string };

/**
 * The datagram payload ceiling, matching wasmtime-wasi's
 * `MAX_UDP_DATAGRAM_SIZE` (`u16::MAX`). Larger sends fail
 * `datagram-too-large` before reaching the OS; receives use a buffer of
 * this size so no datagram the OS delivers is ever truncated.
 */
export const MAX_UDP_DATAGRAM_SIZE = 65535;

/**
 * A WIT `err` the branded way (contracts/embedder-api.md, "Error model"):
 * an unbranded throw would become a trap naming the import instead of a
 * guest-visible err.
 */
function componentError(
  payload: SocketErrorCode,
  detail: string,
): ComponentException<SocketErrorCode> {
  return new ComponentException<SocketErrorCode>(
    payload,
    `wasi:sockets/types@0.3: ${detail}`,
  );
}

// --- the platform seam ----------------------------------------------------------
//
// Backends and detection live in sockets_platform.ts: Deno-native APIs
// whenever a `Deno` global exists (`Deno.listenDatagram` needs
// `--unstable-net`; `Deno.connect` is stable), node builtins
// (`node:dgram`/`node:net` via `process.getBuiltinModule`) otherwise —
// real Node, and Bun through its node compat. Everything is looked up
// through `globalThis` at call time, so the module never assumes a
// platform at evaluation and `create` answers `not-supported` truthfully
// on hosts with neither backend.

import {
  type DatagramConn,
  dnsLookup,
  listenDatagram,
  type NetAddr,
  type TcpConn,
  tcpConnect,
  tcpListen,
  type TcpListener,
} from "./sockets_platform.ts";

export type { NetAddr };

// --- address codec ------------------------------------------------------------

/** Render the address part of `addr` as a Deno hostname string. */
export function ipHostname(addr: IpSocketAddress): string {
  if (addr.kind === "ipv4") return addr.value.address.join(".");
  // The uncompressed spelling; Deno's address parser accepts it.
  return addr.value.address.map((g) => g.toString(16)).join(":");
}

/**
 * Parse a Deno `NetAddr` back into a WIT `ip-socket-address`.
 *
 * Handles the compressed (`::1`), full, IPv4-embedded (`::ffff:127.0.0.1` —
 * what a dual-stack socket reports for IPv4 senders), and zoned
 * (`fe80::1%3`) hostname spellings. A zone parses as the numeric scope-id
 * when it is numeric and drops to 0 otherwise (interface names are not
 * representable in the WIT shape); flow-info is not observable and is
 * always 0.
 */
export function parseNetAddr(addr: NetAddr): IpSocketAddress {
  const host = addr.hostname;
  if (!host.includes(":")) {
    const octets = host.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw componentError(
        { kind: "other", value: `unparseable IPv4 hostname ${JSON.stringify(host)}` },
        `unparseable IPv4 hostname ${JSON.stringify(host)}`,
      );
    }
    return {
      kind: "ipv4",
      value: { port: addr.port, address: octets as Ipv4Address },
    };
  }
  const { groups, scopeId } = parseIpv6Hostname(host);
  return {
    kind: "ipv6",
    value: { port: addr.port, flowInfo: 0, address: groups, scopeId },
  };
}

function parseIpv6Hostname(hostname: string): { groups: Ipv6Address; scopeId: number } {
  let host = hostname;
  let scopeId = 0;
  const pct = host.indexOf("%");
  if (pct >= 0) {
    const zone = Number(host.slice(pct + 1));
    scopeId = Number.isInteger(zone) && zone >= 0 ? zone : 0;
    host = host.slice(0, pct);
  }

  const fail = (): never => {
    throw componentError(
      { kind: "other", value: `unparseable IPv6 hostname ${JSON.stringify(hostname)}` },
      `unparseable IPv6 hostname ${JSON.stringify(hostname)}`,
    );
  };
  const dc = host.indexOf("::");
  let head: string[];
  let tail: string[];
  if (dc >= 0) {
    if (host.indexOf("::", dc + 1) >= 0) fail();
    head = dc === 0 ? [] : host.slice(0, dc).split(":");
    tail = dc + 2 === host.length ? [] : host.slice(dc + 2).split(":");
  } else {
    head = host.split(":");
    tail = [];
  }

  // An embedded dotted quad ("::ffff:127.0.0.1") occupies the last two
  // groups.
  const last = tail.length > 0 ? tail : head;
  const pieces = [...head];
  let tailPieces = [...tail];
  let v4Tail: [number, number] | undefined;
  if (last.length > 0 && last[last.length - 1].includes(".")) {
    const quad = last[last.length - 1].split(".").map(Number);
    if (quad.length !== 4 || quad.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) fail();
    v4Tail = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    if (tail.length > 0) tailPieces = tail.slice(0, -1);
    else pieces.pop();
  }

  const parseGroup = (piece: string): number => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) fail();
    return parseInt(piece, 16);
  };
  const headGroups = pieces.map(parseGroup);
  const tailGroups = [...tailPieces.map(parseGroup), ...(v4Tail ?? [])];
  const total = headGroups.length + tailGroups.length;
  if (dc >= 0) {
    if (total > 7) fail();
    while (headGroups.length + tailGroups.length < 8) headGroups.push(0);
  } else if (total !== 8) {
    fail();
  }
  return { groups: [...headGroups, ...tailGroups] as Ipv6Address, scopeId };
}

// --- validation (wasmtime-wasi `sockets/util.rs` parity) ----------------------

function isV4MappedV6(groups: Ipv6Address): boolean {
  return groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
}

/** The deprecated IPv4-compatible range, excluding `::` and `::1`. */
function isDeprecatedV4CompatibleV6(groups: Ipv6Address): boolean {
  const headZero = groups.slice(0, 6).every((g) => g === 0);
  if (!headZero) return false;
  const unspecified = groups[6] === 0 && groups[7] === 0;
  const localhost = groups[6] === 0 && groups[7] === 1;
  return !unspecified && !localhost;
}

/**
 * Whether `addr` may cross this socket's family boundary: same family, and
 * never an IPv4-mapped or deprecated IPv4-compatible IPv6 address.
 */
export function isValidAddressFamily(family: IpAddressFamily, addr: IpSocketAddress): boolean {
  if (family === "ipv4") return addr.kind === "ipv4";
  return addr.kind === "ipv6" &&
    !isV4MappedV6(addr.value.address) &&
    !isDeprecatedV4CompatibleV6(addr.value.address);
}

export function isUnspecified(addr: IpSocketAddress): boolean {
  if (addr.kind === "ipv4") return addr.value.address.every((o) => o === 0);
  return addr.value.address.every((g) => g === 0);
}

/** Same endpoint: family, address, and port (udp connected-mode filter). */
export function sameSocketAddress(a: IpSocketAddress, b: IpSocketAddress): boolean {
  if (a.kind !== b.kind || a.value.port !== b.value.port) return false;
  return a.value.address.length === b.value.address.length &&
    a.value.address.every((part, i) => part === b.value.address[i]);
}

// --- error mapping ------------------------------------------------------------

/** `e instanceof Deno.errors[name]`, tolerating hosts/versions lacking the class. */
function isDenoError(e: unknown, name: string): boolean {
  const deno = (globalThis as { Deno?: unknown }).Deno;
  if (typeof deno !== "object" || deno === null) return false;
  const errors = (deno as Record<string, unknown>).errors;
  if (typeof errors !== "object" || errors === null) return false;
  const cls = (errors as Record<string, unknown>)[name];
  return typeof cls === "function" &&
    e instanceof (cls as new () => Error);
}

/**
 * Node-style `err.code` -> WIT `error-code` (the node backend's whole
 * error vocabulary, and a sharper channel than Deno's classes where both
 * exist). The `ERR_*` rows are the adapters' closed-under-a-pending-op
 * signals, mirroring what Deno's BadResource maps to.
 */
const CODE_ERRORS: Record<string, SocketErrorCode> = {
  EADDRINUSE: { kind: "address-in-use" },
  EADDRNOTAVAIL: { kind: "address-not-bindable" },
  ECONNREFUSED: { kind: "connection-refused" },
  ECONNRESET: { kind: "connection-reset" },
  ECONNABORTED: { kind: "connection-aborted" },
  EHOSTUNREACH: { kind: "remote-unreachable" },
  EHOSTDOWN: { kind: "remote-unreachable" },
  ENETUNREACH: { kind: "remote-unreachable" },
  ENETDOWN: { kind: "remote-unreachable" },
  ENONET: { kind: "remote-unreachable" },
  EACCES: { kind: "access-denied" },
  EPERM: { kind: "access-denied" },
  ETIMEDOUT: { kind: "timeout" },
  EMSGSIZE: { kind: "datagram-too-large" },
  EPIPE: { kind: "connection-broken" },
  EINVAL: { kind: "invalid-argument" },
  ENOTSUP: { kind: "not-supported" },
  EOPNOTSUPP: { kind: "not-supported" },
  ERR_SOCKET_DGRAM_NOT_RUNNING: { kind: "invalid-state" },
  ERR_SERVER_NOT_RUNNING: { kind: "invalid-state" },
  ERR_STREAM_DESTROYED: { kind: "invalid-state" },
  ERR_STREAM_WRITE_AFTER_END: { kind: "invalid-state" },
};

/**
 * Map a platform failure onto the WIT `error-code` vocabulary, mirroring
 * wasmtime-wasi's io-error table where the platform exposes the
 * distinction — Deno's error classes first, then Node-style `code`
 * strings, then the plain-`Error` spellings Deno leaves unclassified. An
 * already-branded error passes through unchanged — the codec and the
 * capability re-detection throw branded errors from inside the same try
 * blocks that guard the platform calls, and re-wrapping one would demote
 * its payload to `other`.
 */
export function mapPlatformError(e: unknown, what: string): ComponentException<SocketErrorCode> {
  if (e instanceof ComponentException) return e as ComponentException<SocketErrorCode>;
  const message = e instanceof Error ? e.message : String(e);
  const err = (payload: SocketErrorCode): ComponentException<SocketErrorCode> =>
    componentError(payload, `${what}: ${message}`);
  if (isDenoError(e, "AddrInUse")) return err({ kind: "address-in-use" });
  if (isDenoError(e, "AddrNotAvailable")) return err({ kind: "address-not-bindable" });
  if (isDenoError(e, "ConnectionRefused")) return err({ kind: "connection-refused" });
  if (isDenoError(e, "ConnectionReset")) return err({ kind: "connection-reset" });
  if (isDenoError(e, "ConnectionAborted")) return err({ kind: "connection-aborted" });
  if (isDenoError(e, "NetworkUnreachable") || isDenoError(e, "HostUnreachable")) {
    return err({ kind: "remote-unreachable" });
  }
  if (isDenoError(e, "PermissionDenied") || isDenoError(e, "NotCapable")) {
    return err({ kind: "access-denied" });
  }
  if (isDenoError(e, "TimedOut")) return err({ kind: "timeout" });
  // A socket closed under a pending operation: the operation was not valid
  // in the socket's (now closed) state.
  if (isDenoError(e, "Interrupted") || isDenoError(e, "BadResource")) {
    return err({ kind: "invalid-state" });
  }
  if (isDenoError(e, "NotSupported")) return err({ kind: "not-supported" });
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code in CODE_ERRORS) return err(CODE_ERRORS[code]);
  // EMSGSIZE surfaces as a plain Error, not a Deno.errors class.
  if (/message too long/i.test(message)) return err({ kind: "datagram-too-large" });
  // EPIPE (a write on a peer-closed connection) also surfaces as a plain
  // Error in Deno.
  if (/broken pipe/i.test(message)) return err({ kind: "connection-broken" });
  if (e instanceof TypeError) return err({ kind: "invalid-argument" });
  return err({ kind: "other", value: message });
}

// --- result values -------------------------------------------------------------
//
// TCP `send`/`receive` report failures through `future<result<_,
// error-code>>` — a result AS A VALUE (contracts/embedder-api.md §"Type
// mapping"), not a throw: the functions themselves are infallible in WIT,
// so a branded throw would be a trap, and an UNRESOLVED future would be a
// hang. These helpers build the `{ kind, value }` result family.

/** `result<_, error-code>` as a value (the payload of tcp send/receive futures). */
export type SocketResult =
  | { kind: "ok" }
  | { kind: "err"; value: SocketErrorCode };

const RESULT_OK: SocketResult = { kind: "ok" };

const RESULT_INVALID_STATE: SocketResult = {
  kind: "err",
  value: { kind: "invalid-state" },
};

/** The err side of a `SocketResult`, mapped from a platform failure. */
function resultErrOf(e: unknown, what: string): SocketResult {
  return { kind: "err", value: mapPlatformError(e, what).payload };
}

// --- the fragment --------------------------------------------------------------

export interface SocketsOptions {
  /**
   * Observe every `wasi:sockets` entry point the guest reaches, in call
   * order (`"udp-socket.create"`, `"tcp-socket.connect"`, …). For host-side
   * test assertions — a relay-only scenario can assert zero calls, an exam
   * can read back the guest's exact driving sequence. No default cost: when
   * absent, nothing is recorded.
   */
  onCall?: (call: string) => void;
}

/**
 * The host-implemented `udp-socket` resource surface: a plain class with
 * camelCase methods and the WIT `static` as a JS static
 * (contracts/embedder-api.md, "Resources"). The runtime calls
 * `[Symbol.dispose]` when the guest drops its last handle; that closes the
 * OS socket, settling any still-pending `receive` as a branded err.
 */
export interface UdpSocket {
  bind(localAddress: IpSocketAddress): void;
  connect(remoteAddress: IpSocketAddress): Promise<void>;
  disconnect(): void;
  send(data: Uint8Array, remoteAddress: IpSocketAddress | undefined): Promise<void>;
  receive(): Promise<[Uint8Array, IpSocketAddress]>;
  getLocalAddress(): IpSocketAddress;
  getRemoteAddress(): IpSocketAddress;
  getAddressFamily(): IpAddressFamily;
  getUnicastHopLimit(): number;
  setUnicastHopLimit(value: number): void;
  getReceiveBufferSize(): bigint;
  setReceiveBufferSize(value: bigint): void;
  getSendBufferSize(): bigint;
  setSendBufferSize(value: bigint): void;
  [Symbol.dispose](): void;
}

/** The `udp-socket` resource class a fragment carries. */
export interface UdpSocketClass {
  create(addressFamily: IpAddressFamily): UdpSocket;
}

/**
 * What tcp `send` accepts: the lifted `Stream<u8>` handle the runtime
 * dispatches (its async iterator yields `Uint8Array` chunks), or any
 * natural byte-chunk producer for direct/test use.
 */
export type TcpSendSource =
  | Stream<number>
  | AsyncIterable<Uint8Array | number[]>
  | Iterable<Uint8Array | number[]>;

/** What tcp `receive` returns in stream position: chunks of bytes. */
export type TcpByteStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * What tcp `listen` returns: the perpetual accept stream. `cancel` is the
 * A13 producer-cancellation hook the runtime's pump invokes when the
 * guest drops the stream while the loop is parked in accept(); direct
 * (non-runtime) consumers may call it themselves to stop accepting.
 */
export type TcpAcceptStream = AsyncIterable<TcpSocket> & { cancel(): void };

/**
 * The host-implemented `tcp-socket` resource surface (client + listener
 * halves — module header). `send` is a WIT sync func returning
 * `future<result>`: the async method's promise is lowered as the future
 * source (amendment A12), so the guest's call returns immediately and the
 * future settles when transmission completes. `receive`'s tuple carries
 * the byte stream and the future that reports FIN (`ok`) vs abnormal
 * close (`err`). `listen` returns the perpetual accept stream — an
 * async iterable of connected `TcpSocket` resources, lowered as
 * `stream<own<tcp-socket>>` (amendment A13: elements the guest never
 * takes are destroyed, closing their connections). Dropping the guest
 * handle does NOT close a socket with live pumps or a live accept stream
 * (the WIT's shared-ownership note); the OS socket closes when the
 * handle and every derived stream are all retired.
 */
export interface TcpSocket {
  bind(localAddress: IpSocketAddress): void;
  connect(remoteAddress: IpSocketAddress): Promise<void>;
  listen(): Promise<TcpAcceptStream>;
  send(data: TcpSendSource): Promise<SocketResult>;
  receive(): [TcpByteStream, Promise<SocketResult>];
  getLocalAddress(): IpSocketAddress;
  getRemoteAddress(): IpSocketAddress;
  getAddressFamily(): IpAddressFamily;
  getIsListening(): boolean;
  setListenBacklogSize(value: bigint): void;
  getKeepAliveEnabled(): boolean;
  setKeepAliveEnabled(value: boolean): void;
  getKeepAliveIdleTime(): bigint;
  setKeepAliveIdleTime(value: bigint): void;
  getKeepAliveInterval(): bigint;
  setKeepAliveInterval(value: bigint): void;
  getKeepAliveCount(): number;
  setKeepAliveCount(value: number): void;
  getHopLimit(): number;
  setHopLimit(value: number): void;
  getReceiveBufferSize(): bigint;
  setReceiveBufferSize(value: bigint): void;
  getSendBufferSize(): bigint;
  setSendBufferSize(value: bigint): void;
  [Symbol.dispose](): void;
}

/** The `tcp-socket` resource class a fragment carries. */
export interface TcpSocketClass {
  create(addressFamily: IpAddressFamily): TcpSocket;
}

export const SOCKETS_TYPES_INTERFACE = "wasi:sockets/types@0.3";

/** What `sockets()` returns: the imports fragment plus the fragment's classes. */
export interface SocketsShim {
  imports: Record<string, unknown>;
  /** This fragment's resource classes (exposed for direct/test use). */
  UdpSocket: UdpSocketClass;
  TcpSocket: TcpSocketClass;
  /** `ip-name-lookup.resolve-addresses` (exposed for direct/test use). */
  resolveAddresses: (name: string) => Promise<IpAddress[]>;
}

/**
 * `wasi:sockets/types@0.3` provider fragment (track key: one provider
 * serves every 0.3.x the resolver folds onto the track). The resource
 * class is built per fragment so the `onCall` observer is scoped to it.
 */
export function sockets(options: SocketsOptions = {}): SocketsShim {
  const onCall = options.onCall ?? ((): void => {});

  class UdpSocket {
    #family: IpAddressFamily;
    #conn: DatagramConn | undefined;
    /** Connected-mode remote (`connect`/`disconnect`); OS-level (kernel
     * filters and default destination), not adapter emulation. */
    #remote: IpSocketAddress | undefined;
    /** Cached option values, applied at (implicit) bind. */
    #hopLimit: number | undefined;
    #recvBuffer: bigint | undefined;
    #sendBuffer: bigint | undefined;

    private constructor(family: IpAddressFamily) {
      this.#family = family;
    }

    static create(addressFamily: IpAddressFamily): UdpSocket {
      onCall("udp-socket.create");
      if (listenDatagram() === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.create: this host provides no datagram sockets (no node:dgram)",
        );
      }
      return new UdpSocket(addressFamily);
    }

    bind(localAddress: IpSocketAddress): void {
      onCall("udp-socket.bind");
      if (this.#conn !== undefined) {
        throw componentError({ kind: "invalid-state" }, "udp-socket.bind: already bound");
      }
      if (!isValidAddressFamily(this.#family, localAddress)) {
        throw componentError(
          { kind: "invalid-argument" },
          `udp-socket.bind: address family mismatch (an ${this.#family} socket)`,
        );
      }
      if (localAddress.kind === "ipv6" && localAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.bind: non-zero scope-id (not expressible through Deno.listenDatagram)",
        );
      }
      try {
        this.#conn = this.#listen({
          transport: "udp",
          hostname: ipHostname(localAddress),
          port: localAddress.value.port,
        });
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.bind");
      }
      this.#applyCachedOptions();
    }

    /**
     * WIT (0.3.1): `connect: func(remote-address) -> result<_, error-code>`
     * — OS-level connected mode: the kernel filters inbound datagrams to
     * the remote and `send` needs no explicit address. An unbound socket
     * implicitly binds to the family wildcard first (wasmtime parity).
     *
     * SUSPENDING (A1/A2): node's `dgram.connect` settles via callback one
     * tick later, so this sync WIT func parks the calling frame for that
     * tick — the same shape as tcp `listen`.
     */
    @suspending
    async connect(remoteAddress: IpSocketAddress): Promise<void> {
      onCall("udp-socket.connect");
      if (this.#remote !== undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.connect: already connected (disconnect first)",
        );
      }
      if (
        !isValidAddressFamily(this.#family, remoteAddress) ||
        isUnspecified(remoteAddress) ||
        remoteAddress.value.port === 0
      ) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.connect: the remote address must be a specific address " +
            `and non-zero port in the socket's family (${this.#family})`,
        );
      }
      if (remoteAddress.kind === "ipv6" && remoteAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.connect: non-zero scope-id (not expressible through node addresses)",
        );
      }
      if (this.#conn === undefined) {
        try {
          this.#conn = this.#listen({
            transport: "udp",
            hostname: this.#family === "ipv4" ? "0.0.0.0" : "::",
            port: 0,
          });
        } catch (e) {
          throw mapPlatformError(e, "udp-socket.connect (implicit bind)");
        }
        this.#applyCachedOptions();
      }
      if (this.#conn.connect === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.connect: this host's datagram backend has no connected mode",
        );
      }
      try {
        await this.#conn.connect({
          transport: "udp",
          hostname: ipHostname(remoteAddress),
          port: remoteAddress.value.port,
        });
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.connect");
      }
      this.#remote = remoteAddress;
    }

    disconnect(): void {
      onCall("udp-socket.disconnect");
      if (this.#remote === undefined || this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.disconnect: the socket is not connected",
        );
      }
      try {
        this.#conn.disconnect?.();
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.disconnect");
      }
      this.#remote = undefined;
    }

    async send(data: Uint8Array, remoteAddress: IpSocketAddress | undefined): Promise<void> {
      onCall("udp-socket.send");
      if (data.length > MAX_UDP_DATAGRAM_SIZE) {
        throw componentError(
          { kind: "datagram-too-large" },
          `udp-socket.send: ${data.length} bytes exceeds the ${MAX_UDP_DATAGRAM_SIZE}-byte ceiling`,
        );
      }
      // Connected mode (0.3.1): an omitted remote sends to the connected
      // address (the kernel's default destination); a PRESENT remote on a
      // connected socket is invalid-argument (wasmtime parity — node's
      // dgram would raise ERR_SOCKET_DGRAM_IS_CONNECTED anyway). On an
      // unconnected socket an omitted remote has no destination (POSIX
      // EDESTADDRREQ).
      if (remoteAddress === undefined) {
        if (this.#remote === undefined) {
          throw componentError(
            { kind: "invalid-argument" },
            "udp-socket.send: no remote-address, and the socket is not connected",
          );
        }
        if (this.#conn === undefined) {
          throw componentError(
            { kind: "invalid-state" },
            "udp-socket.send: connected but unbound (unreachable)",
          );
        }
        try {
          const sent = await this.#conn.send(data);
          if (sent !== data.length) {
            throw componentError(
              { kind: "other", value: `partial send: ${sent} of ${data.length} bytes` },
              `udp-socket.send: partial send: ${sent} of ${data.length} bytes`,
            );
          }
        } catch (e) {
          throw mapPlatformError(e, "udp-socket.send");
        }
        return;
      }
      if (this.#remote !== undefined) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.send: an explicit remote-address on a connected socket",
        );
      }
      if (this.#conn === undefined) {
        // "If the socket has not been explicitly bound, it will be implicitly
        // bound to a random free port" — the wildcard bind wasmtime performs.
        try {
          this.#conn = this.#listen({
            transport: "udp",
            hostname: this.#family === "ipv4" ? "0.0.0.0" : "::",
            port: 0,
          });
        } catch (e) {
          throw mapPlatformError(e, "udp-socket.send (implicit bind)");
        }
        this.#applyCachedOptions();
      }
      if (
        !isValidAddressFamily(this.#family, remoteAddress) ||
        isUnspecified(remoteAddress) ||
        remoteAddress.value.port === 0
      ) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.send: the remote address must be a specific address and " +
            `non-zero port in the socket's family (${this.#family})`,
        );
      }
      if (remoteAddress.kind === "ipv6" && remoteAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.send: non-zero scope-id (not expressible through Deno addresses)",
        );
      }
      let sent: number;
      try {
        sent = await this.#conn.send(data, {
          transport: "udp",
          hostname: ipHostname(remoteAddress),
          port: remoteAddress.value.port,
        });
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.send");
      }
      if (sent !== data.length) {
        throw componentError(
          { kind: "other", value: `partial send: ${sent} of ${data.length} bytes` },
          `udp-socket.send: partial send: ${sent} of ${data.length} bytes`,
        );
      }
    }

    async receive(): Promise<[Uint8Array, IpSocketAddress]> {
      onCall("udp-socket.receive");
      if (this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.receive: the socket is not bound",
        );
      }
      try {
        for (;;) {
          // Each datagram arrives as its own exactly-sized buffer; nothing
          // the OS delivers is ever truncated (whole-datagram semantics).
          const [payload, from] = await this.#conn.receive();
          const source = parseNetAddr(from);
          // The connected-mode filter, as a BACKSTOP over the OS's: the
          // WIT pins "only receive datagrams from that address", the
          // kernel filters on real node, but Deno's dgram compat treats
          // connect() as a default destination only — so non-matching
          // sources are dropped here either way (matching what a kernel
          // filter would have done silently).
          if (this.#remote === undefined || sameSocketAddress(source, this.#remote)) {
            return [payload, source];
          }
        }
      } catch (e) {
        throw mapPlatformError(e, "udp-socket.receive");
      }
    }

    getLocalAddress(): IpSocketAddress {
      onCall("udp-socket.get-local-address");
      if (this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.get-local-address: the socket is not bound",
        );
      }
      return parseNetAddr(this.#conn.addr);
    }

    getRemoteAddress(): IpSocketAddress {
      onCall("udp-socket.get-remote-address");
      if (this.#remote === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "udp-socket.get-remote-address: the socket is not connected",
        );
      }
      return this.#remote;
    }

    getAddressFamily(): IpAddressFamily {
      onCall("udp-socket.get-address-family");
      return this.#family;
    }

    /** Stored-value getter (documented default 64, the common OS default):
     * node exposes a setter (`setTTL`) but no getter. */
    getUnicastHopLimit(): number {
      onCall("udp-socket.get-unicast-hop-limit");
      return this.#hopLimit ?? 64;
    }

    setUnicastHopLimit(value: number): void {
      onCall("udp-socket.set-unicast-hop-limit");
      if (value < 1) {
        // The WIT pins this: "set-unicast-hop-limit(0)" must fail.
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.set-unicast-hop-limit: the hop limit must be at least 1",
        );
      }
      this.#hopLimit = value;
      if (this.#conn !== undefined) this.#applyCachedOptions();
    }

    getReceiveBufferSize(): bigint {
      onCall("udp-socket.get-receive-buffer-size");
      return this.#bufferSize("receive", this.#recvBuffer, this.#conn?.getRecvBufferSize);
    }

    setReceiveBufferSize(value: bigint): void {
      onCall("udp-socket.set-receive-buffer-size");
      if (value === 0n) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.set-receive-buffer-size: zero is not a buffer size",
        );
      }
      this.#recvBuffer = value;
      if (this.#conn !== undefined) this.#applyCachedOptions();
    }

    getSendBufferSize(): bigint {
      onCall("udp-socket.get-send-buffer-size");
      return this.#bufferSize("send", this.#sendBuffer, this.#conn?.getSendBufferSize);
    }

    setSendBufferSize(value: bigint): void {
      onCall("udp-socket.set-send-buffer-size");
      if (value === 0n) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.set-send-buffer-size: zero is not a buffer size",
        );
      }
      this.#sendBuffer = value;
      if (this.#conn !== undefined) this.#applyCachedOptions();
    }

    /** Live kernel value when bound (SO_RCVBUF doubling and clamping
     * included), the cached request before that, `not-supported` when
     * neither exists (the OS default is unknowable pre-bind here). */
    #bufferSize(
      which: "receive" | "send",
      cached: bigint | undefined,
      live: (() => number) | undefined,
    ): bigint {
      if (this.#conn !== undefined && live !== undefined) {
        try {
          return BigInt(live.call(this.#conn));
        } catch (e) {
          throw mapPlatformError(e, `udp-socket.get-${which}-buffer-size`);
        }
      }
      if (cached !== undefined) return cached;
      throw componentError(
        { kind: "not-supported" },
        `udp-socket.get-${which}-buffer-size: unknowable before bind on this host`,
      );
    }

    /** Cached options -> the live socket (at bind, and on later sets). */
    #applyCachedOptions(): void {
      const conn = this.#conn;
      if (conn === undefined) return;
      try {
        if (this.#hopLimit !== undefined) conn.setTtl?.(this.#hopLimit);
        if (this.#recvBuffer !== undefined) {
          conn.setRecvBufferSize?.(Number(this.#recvBuffer));
        }
        if (this.#sendBuffer !== undefined) {
          conn.setSendBufferSize?.(Number(this.#sendBuffer));
        }
      } catch (e) {
        throw mapPlatformError(e, "udp-socket (applying cached options)");
      }
    }

    [Symbol.dispose](): void {
      const conn = this.#conn;
      this.#conn = undefined;
      if (conn !== undefined) {
        try {
          conn.close();
        } catch {
          // Already closed.
        }
      }
    }

    /** Re-detect per call: `create`'s answer must not outlive a test's stub. */
    #listen(opts: { transport: "udp"; hostname: string; port: number }): DatagramConn {
      const listen = listenDatagram();
      if (listen === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket: the datagram backend disappeared after create",
        );
      }
      return listen(opts);
    }
  }

  class TcpSocket {
    #family: IpAddressFamily;
    #state: "unbound" | "bound" | "connecting" | "connected" | "listening" | "closed" = "unbound";
    #conn: TcpConn | undefined;
    #listener: TcpListener | undefined;
    /** The address `bind` recorded; the OS bind happens at `listen` (header). */
    #localRequest: IpSocketAddress | undefined;
    #sendCalled = false;
    #receiveCalled = false;
    /** listen()'s accept-queue hint (`set-listen-backlog-size`). */
    #backlog: number | undefined;
    /** SO_KEEPALIVE + TCP_KEEPIDLE cache (node's exact option surface);
     * applied at connect and on set-while-connected. The idle default is
     * Linux's tcp_keepalive_time (7200 s) — DOCUMENTED, not read from
     * the OS (node exposes no getter). */
    #keepAliveEnabled = false;
    #keepAliveIdleNs = 7_200_000_000_000n;
    /**
     * Shared-ownership references (WIT: "The OS socket is closed only
     * after the last handle is dropped"): the resource handle plus each
     * live pump and the accept stream. The conn/listener close at zero —
     * so a live send, receive, or accept stream keeps the socket open
     * past the guest dropping the handle.
     */
    #refs = 1;
    #handleDropped = false;

    private constructor(family: IpAddressFamily) {
      this.#family = family;
    }

    /** An accepted connection, already in the `connected` state. */
    static #accepted(family: IpAddressFamily, conn: TcpConn): TcpSocket {
      const socket = new TcpSocket(family);
      socket.#conn = conn;
      socket.#state = "connected";
      return socket;
    }

    static create(addressFamily: IpAddressFamily): TcpSocket {
      onCall("tcp-socket.create");
      if (tcpConnect() === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.create: this host provides no TCP sockets (no node:net)",
        );
      }
      return new TcpSocket(addressFamily);
    }

    /**
     * Records the local address; the OS bind is DEFERRED to `listen` or
     * `connect` (recorded divergence: node cannot bind a socket it has
     * not yet connected or listened — so `address-in-use` and friends
     * surface at those calls, with their real codes).
     */
    bind(localAddress: IpSocketAddress): void {
      onCall("tcp-socket.bind");
      if (this.#state !== "unbound") {
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.bind: not bindable from the '${this.#state}' state`,
        );
      }
      if (!isValidAddressFamily(this.#family, localAddress)) {
        throw componentError(
          { kind: "invalid-argument" },
          `tcp-socket.bind: address family mismatch (an ${this.#family} socket)`,
        );
      }
      if (localAddress.kind === "ipv6" && localAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.bind: non-zero scope-id (not expressible through node addresses)",
        );
      }
      this.#localRequest = localAddress;
      this.#state = "bound";
    }

    async connect(remoteAddress: IpSocketAddress): Promise<void> {
      onCall("tcp-socket.connect");
      if (this.#state !== "unbound" && this.#state !== "bound") {
        // Includes `closed` after a failed attempt: "A single socket can
        // not be used to connect more than once."
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.connect: not connectable from the '${this.#state}' state`,
        );
      }
      if (
        !isValidAddressFamily(this.#family, remoteAddress) ||
        isUnspecified(remoteAddress) ||
        remoteAddress.value.port === 0
      ) {
        throw componentError(
          { kind: "invalid-argument" },
          "tcp-socket.connect: the remote address must be a specific unicast " +
            `address and non-zero port in the socket's family (${this.#family})`,
        );
      }
      if (remoteAddress.kind === "ipv6" && remoteAddress.value.scopeId !== 0) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.connect: non-zero scope-id (not expressible through node addresses)",
        );
      }
      const connect = tcpConnect();
      if (connect === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket: the TCP backend disappeared after create",
        );
      }
      // Connect-from-bound: `bind` recorded the local address; the OS
      // bind happens here, as part of the dial (`net.connect`'s
      // localAddress/localPort) — so bind errors (address-in-use,
      // address-not-bindable) surface at connect, the deferred-bind
      // divergence the module header records.
      const local = this.#localRequest;
      this.#state = "connecting";
      let conn: TcpConn;
      try {
        conn = await connect({
          transport: "tcp",
          hostname: ipHostname(remoteAddress),
          port: remoteAddress.value.port,
          ...(local === undefined ? {} : {
            localHostname: ipHostname(local),
            localPort: local.value.port,
          }),
        });
      } catch (e) {
        // "After a failed connection attempt, the socket will be in the
        // `closed` state and the only valid action left is to `drop`".
        this.#state = "closed";
        throw mapPlatformError(e, "tcp-socket.connect");
      }
      if (this.#state !== "connecting") {
        // Disposed while the dial was in flight: nothing owns the fresh
        // conn — close it rather than leak it.
        try {
          conn.close();
        } catch {
          // Already closed.
        }
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.connect: the socket was dropped during connect",
        );
      }
      this.#conn = conn;
      this.#state = "connected";
      this.#applyKeepAlive(); // options set before connect reach the OS here
    }

    /**
     * WIT: `listen: func() -> result<stream<tcp-socket>, error-code>` —
     * transitions to `listening` and returns the perpetual accept stream,
     * whose elements are connected `TcpSocket` resources (lowered as
     * `own<tcp-socket>` — amendment A13 destroys any element the guest
     * never takes, closing that accepted connection). An unbound socket
     * implicitly binds to the family wildcard with an ephemeral port.
     *
     * SUSPENDING (embedder-api A1/A2, the wasi:io `block` kernel): the OS
     * bind is deferred one event-loop turn by `net.Server.listen` (module
     * header), so this async method awaits the settle and the runtime
     * parks the calling guest frame for that one tick. Full listener
     * fidelity follows: `get-local-address` is real immediately after,
     * and a failed bind is a branded err with its real code
     * (address-in-use, …). Guests that link `listen` auto-select jspi
     * mode on JSPI engines; engines without JSPI would raise `NeedsJspi`
     * here — currently moot everywhere deltic guests run (JSC lacks
     * multi-memory, and browsers have no sockets).
     *
     * The stream only ends on fatal errors — the listener dying — while
     * per-connection accept failures are skipped, per the WIT's
     * implementors note.
     */
    @suspending
    async listen(): Promise<TcpAcceptStream> {
      onCall("tcp-socket.listen");
      if (this.#state !== "unbound" && this.#state !== "bound") {
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.listen: not listenable from the '${this.#state}' state`,
        );
      }
      const listen = tcpListen();
      if (listen === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.listen: this host provides no TCP listeners (no node:net)",
        );
      }
      const local = this.#localRequest ?? wildcardAddress(this.#family);
      const listener = listen({
        transport: "tcp",
        hostname: ipHostname(local),
        port: local.value.port,
        ...(this.#backlog === undefined ? {} : { backlog: this.#backlog }),
      });
      try {
        await listener.settled(); // the one-tick park (doc comment above)
      } catch (e) {
        listener.close();
        this.#state = "closed";
        throw mapPlatformError(e, "tcp-socket.listen");
      }
      this.#listener = listener;
      this.#state = "listening";
      this.#refs++; // the accept stream keeps the listener alive
      const family = this.#family;
      const release = (): void => this.#release();
      const source = (async function* (): AsyncGenerator<TcpSocket> {
        try {
          for (;;) {
            let conn: TcpConn;
            try {
              conn = await listener.accept();
            } catch (e) {
              const kind = mapPlatformError(e, "tcp-socket.listen (accept)")
                .payload.kind;
              // Per-connection failures are skipped (the WIT implementors
              // note: "log it and then skip over non-fatal errors");
              // anything else means the LISTENER is dead — closed under
              // us, or never came up — and ends the perpetual stream.
              if (TRANSIENT_ACCEPT_FAILURES.has(kind)) continue;
              return;
            }
            yield TcpSocket.#accepted(family, conn);
          }
        } finally {
          release();
        }
      })();
      // The A13 producer-cancellation hook: when the guest drops the
      // stream while the loop above is PARKED in accept(), the runtime's
      // pump invokes this — closing the listener is what unparks the
      // accept (it rejects; classified fatal; the generator retires).
      return Object.assign(source, {
        cancel: (): void => {
          try {
            listener.close();
          } catch {
            // Already closed.
          }
        },
      });
    }

    /**
     * WIT: `send: func(data: stream<u8>) -> future<result<_, error-code>>`
     * — a sync func; the returned promise is the future source (A12).
     * NEVER throws: the function has no error channel of its own, so every
     * failure — including the state-machine ones — resolves the future as
     * an err value. The argument stream is dropped on failure so its
     * guest-side writer settles instead of parking forever.
     */
    send(data: TcpSendSource): Promise<SocketResult> {
      onCall("tcp-socket.send");
      if (this.#state !== "connected" || this.#sendCalled || this.#conn === undefined) {
        dropSendSource(data);
        return Promise.resolve(RESULT_INVALID_STATE);
      }
      this.#sendCalled = true;
      return this.#sendPump(this.#conn, data);
    }

    async #sendPump(conn: TcpConn, data: TcpSendSource): Promise<SocketResult> {
      this.#refs++;
      try {
        // Guest-side iteration failures (a peer trap while reading the
        // lifted stream) are deliberately NOT caught: they are not socket
        // errors, and the rejection rides the producer-failure channel.
        for await (const chunk of data as AsyncIterable<Uint8Array | number[]>) {
          const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
          let at = 0;
          while (at < bytes.length) {
            let n: number;
            try {
              n = await conn.write(bytes.subarray(at));
            } catch (e) {
              dropSendSource(data);
              return resultErrOf(e, "tcp-socket.send");
            }
            at += n;
          }
        }
        // End of the guest's stream ("the caller should close the stream
        // when it has no more data"): shutdown(SHUT_WR) — the FIN. The
        // future resolves ok only once the full contents are transmitted.
        try {
          await conn.closeWrite();
        } catch (e) {
          return resultErrOf(e, "tcp-socket.send");
        }
        return RESULT_OK;
      } finally {
        this.#release();
      }
    }

    /**
     * WIT: `receive: func() -> tuple<stream<u8>, future<result<_,
     * error-code>>>`. NEVER throws; a not-connected or repeat call returns
     * a closed stream and an already-err future, per the WIT. The stream
     * ends cleanly (never fake data) on BOTH graceful FIN and abnormal
     * close — the future distinguishes them (`ok` vs `err`). Dropping the
     * stream's reader (guest SHUT_RD) stops the pump, discards queued
     * data, and settles the future ok — the canceller is the observer
     * (the same logic as embedder-api A8's cancelRead ruling).
     */
    receive(): [TcpByteStream, Promise<SocketResult>] {
      onCall("tcp-socket.receive");
      if (this.#state !== "connected" || this.#receiveCalled || this.#conn === undefined) {
        return [[], Promise.resolve(RESULT_INVALID_STATE)];
      }
      this.#receiveCalled = true;
      const conn = this.#conn;
      this.#refs++;
      let settle!: (v: SocketResult) => void;
      const done = new Promise<SocketResult>((r) => (settle = r));
      const release = (): void => this.#release();
      const source = (async function* (): AsyncGenerator<Uint8Array> {
        try {
          for (;;) {
            // The chunk is node's own buffer (no copy); it is borrowed by
            // the rendezvous until the peer takes it (A5), which is safe —
            // each read hands back a distinct buffer.
            let chunk: Uint8Array | null;
            try {
              chunk = await conn.read(TCP_RECEIVE_CHUNK);
            } catch (e) {
              settle(resultErrOf(e, "tcp-socket.receive"));
              return;
            }
            if (chunk === null) {
              settle(RESULT_OK); // graceful FIN from the peer
              return;
            }
            if (chunk.length > 0) yield chunk;
          }
        } finally {
          settle(RESULT_OK); // no-op if already settled (resolve is once)
          release();
        }
      })();
      return [source, done];
    }

    getLocalAddress(): IpSocketAddress {
      onCall("tcp-socket.get-local-address");
      if (this.#state === "listening" && this.#listener !== undefined) {
        const addr = this.#listener.addr;
        if (addr !== null) return parseNetAddr(addr);
        // Unreachable in practice: `listen` awaited the settle, after
        // which the listener reports its address. Kept as an honest err
        // rather than a non-null assertion.
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.get-local-address: the listener reported no address",
        );
      }
      if (this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.get-local-address: the socket is not bound",
        );
      }
      return parseNetAddr(this.#conn.localAddr);
    }

    getRemoteAddress(): IpSocketAddress {
      onCall("tcp-socket.get-remote-address");
      if (this.#state !== "connected" || this.#conn === undefined) {
        throw componentError(
          { kind: "invalid-state" },
          "tcp-socket.get-remote-address: the socket is not connected",
        );
      }
      return parseNetAddr(this.#conn.remoteAddr);
    }

    getAddressFamily(): IpAddressFamily {
      onCall("tcp-socket.get-address-family");
      return this.#family;
    }

    getIsListening(): boolean {
      onCall("tcp-socket.get-is-listening");
      return this.#state === "listening";
    }

    /** Stored pre-listen and applied as node's `listen` backlog hint;
     * node cannot re-listen, so changing it on a LISTENING socket is
     * `not-supported` (wasmtime re-listens; recorded divergence). */
    setListenBacklogSize(value: bigint): void {
      onCall("tcp-socket.set-listen-backlog-size");
      if (value === 0n) {
        throw componentError(
          { kind: "invalid-argument" },
          "tcp-socket.set-listen-backlog-size: zero is not a backlog",
        );
      }
      if (this.#state === "listening") {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket.set-listen-backlog-size: node cannot re-listen an active listener",
        );
      }
      if (this.#state !== "unbound" && this.#state !== "bound") {
        throw componentError(
          { kind: "invalid-state" },
          `tcp-socket.set-listen-backlog-size: not settable in the '${this.#state}' state`,
        );
      }
      // Clamp to a safe int; the OS clamps to SOMAXCONN anyway.
      this.#backlog = Number(value > 0x7fffffffn ? 0x7fffffffn : value);
    }

    getKeepAliveEnabled(): boolean {
      onCall("tcp-socket.get-keep-alive-enabled");
      return this.#keepAliveEnabled;
    }

    setKeepAliveEnabled(value: boolean): void {
      onCall("tcp-socket.set-keep-alive-enabled");
      this.#keepAliveEnabled = value;
      this.#applyKeepAlive();
    }

    /** Stored-value getter (field doc: the default is documented, not
     * read — node has no getter). */
    getKeepAliveIdleTime(): bigint {
      onCall("tcp-socket.get-keep-alive-idle-time");
      return this.#keepAliveIdleNs;
    }

    setKeepAliveIdleTime(value: bigint): void {
      onCall("tcp-socket.set-keep-alive-idle-time");
      if (value < 1n) {
        throw componentError(
          { kind: "invalid-argument" },
          "tcp-socket.set-keep-alive-idle-time: the idle time must be at least 1 ns",
        );
      }
      this.#keepAliveIdleNs = value;
      this.#applyKeepAlive();
    }

    // TCP_KEEPINTVL / TCP_KEEPCNT / IP_TTL / SO_RCVBUF / SO_SNDBUF have no
    // node:net surface at all — answered honestly, not emulated.
    getKeepAliveInterval(): never {
      onCall("tcp-socket.get-keep-alive-interval");
      throw this.#noOption("keep-alive-interval (TCP_KEEPINTVL)");
    }
    setKeepAliveInterval(_value: bigint): never {
      onCall("tcp-socket.set-keep-alive-interval");
      throw this.#noOption("keep-alive-interval (TCP_KEEPINTVL)");
    }
    getKeepAliveCount(): never {
      onCall("tcp-socket.get-keep-alive-count");
      throw this.#noOption("keep-alive-count (TCP_KEEPCNT)");
    }
    setKeepAliveCount(_value: number): never {
      onCall("tcp-socket.set-keep-alive-count");
      throw this.#noOption("keep-alive-count (TCP_KEEPCNT)");
    }
    getHopLimit(): never {
      onCall("tcp-socket.get-hop-limit");
      throw this.#noOption("hop-limit (IP_TTL)");
    }
    setHopLimit(_value: number): never {
      onCall("tcp-socket.set-hop-limit");
      throw this.#noOption("hop-limit (IP_TTL)");
    }
    getReceiveBufferSize(): never {
      onCall("tcp-socket.get-receive-buffer-size");
      throw this.#noOption("receive-buffer-size (SO_RCVBUF)");
    }
    setReceiveBufferSize(_value: bigint): never {
      onCall("tcp-socket.set-receive-buffer-size");
      throw this.#noOption("receive-buffer-size (SO_RCVBUF)");
    }
    getSendBufferSize(): never {
      onCall("tcp-socket.get-send-buffer-size");
      throw this.#noOption("send-buffer-size (SO_SNDBUF)");
    }
    setSendBufferSize(_value: bigint): never {
      onCall("tcp-socket.set-send-buffer-size");
      throw this.#noOption("send-buffer-size (SO_SNDBUF)");
    }

    #noOption(what: string): ComponentException<SocketErrorCode> {
      return componentError(
        { kind: "not-supported" },
        `tcp-socket: node:net exposes no ${what}`,
      );
    }

    /** The keep-alive cache -> the live socket, when there is one. */
    #applyKeepAlive(): void {
      const conn = this.#conn;
      if (this.#state !== "connected" || conn === undefined) return;
      if (conn.setKeepAlive === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "tcp-socket: this host's TCP backend has no keep-alive control",
        );
      }
      try {
        conn.setKeepAlive(this.#keepAliveEnabled, Number(this.#keepAliveIdleNs / 1_000_000n));
      } catch (e) {
        throw mapPlatformError(e, "tcp-socket (applying keep-alive)");
      }
    }

    [Symbol.dispose](): void {
      if (this.#handleDropped) return;
      this.#handleDropped = true;
      if (
        this.#state === "unbound" || this.#state === "bound" ||
        this.#state === "connecting"
      ) {
        // An in-flight dial observes this and closes its fresh conn.
        this.#state = "closed";
      }
      this.#release();
    }

    #release(): void {
      this.#refs--;
      if (this.#refs === 0) {
        const conn = this.#conn;
        this.#conn = undefined;
        if (conn !== undefined) {
          try {
            conn.close();
          } catch {
            // Already closed.
          }
        }
        const listener = this.#listener;
        this.#listener = undefined;
        if (listener !== undefined) {
          try {
            listener.close();
          } catch {
            // Already closed (e.g. by the accept stream's cancel hook).
          }
        }
      }
    }
  }

  /**
   * `wasi:sockets/ip-name-lookup@0.3`: `resolve-addresses: async
   * func(name) -> result<list<ip-address>, error-code>` — getaddrinfo
   * over the platform seam (node:dns `lookup`, i.e. the system resolver,
   * not raw DNS). IP literals resolve locally without touching the
   * resolver (wasmtime parity); answers keep the resolver's order.
   */
  const resolveAddresses = async (name: string): Promise<IpAddress[]> => {
    onCall("ip-name-lookup.resolve-addresses");
    const nameErr = (
      payload: NameLookupErrorCode,
      detail: string,
    ): ComponentException<NameLookupErrorCode> =>
      new ComponentException(payload, `wasi:sockets/ip-name-lookup@0.3: ${detail}`);
    const toIpAddress = (hostname: string): IpAddress => {
      const parsed = parseNetAddr({ hostname, port: 0 });
      return parsed.kind === "ipv4"
        ? { kind: "ipv4", value: parsed.value.address }
        : { kind: "ipv6", value: parsed.value.address };
    };
    if (name.length === 0) {
      throw nameErr({ kind: "invalid-argument" }, "resolve-addresses: empty name");
    }
    // An IP literal is already an answer (and `lookup` would hand it back
    // unchanged anyway — skip the resolver round-trip).
    try {
      return [toIpAddress(name.startsWith("[") ? name.slice(1, -1) : name)];
    } catch {
      // Not a literal: a real name for the resolver.
    }
    const lookup = dnsLookup();
    if (lookup === undefined) {
      throw nameErr(
        { kind: "permanent-resolver-failure" },
        "resolve-addresses: this host provides no resolver (no node:dns)",
      );
    }
    let answers;
    try {
      answers = await lookup(name);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const message = e instanceof Error ? e.message : String(e);
      if (code === "ENOTFOUND" || code === "EAI_NONAME" || code === "ENODATA") {
        throw nameErr({ kind: "name-unresolvable" }, `resolve-addresses: ${message}`);
      }
      if (code === "EAI_AGAIN" || code === "ETIMEOUT" || code === "ETIMEDOUT") {
        throw nameErr(
          { kind: "temporary-resolver-failure" },
          `resolve-addresses: ${message}`,
        );
      }
      if (
        isDenoError(e, "NotCapable") || isDenoError(e, "PermissionDenied") ||
        code === "EACCES" || code === "EPERM"
      ) {
        throw nameErr({ kind: "access-denied" }, `resolve-addresses: ${message}`);
      }
      if (e instanceof TypeError) {
        throw nameErr({ kind: "invalid-argument" }, `resolve-addresses: ${message}`);
      }
      throw nameErr({ kind: "other", value: message }, `resolve-addresses: ${message}`);
    }
    try {
      return answers.map((a) => toIpAddress(a.address));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw nameErr({ kind: "other", value: message }, `resolve-addresses: ${message}`);
    }
  };

  return {
    imports: {
      [SOCKETS_TYPES_INTERFACE]: { UdpSocket, TcpSocket },
      "wasi:sockets/ip-name-lookup@0.3": { resolveAddresses },
      ...sockets02(onCall).imports,
    },
    UdpSocket,
    TcpSocket,
    resolveAddresses,
  };
}

/** How many bytes one tcp receive read asks the OS for. */
const TCP_RECEIVE_CHUNK = 16384;

/**
 * Accept failures that are per-connection, not per-listener: the WIT
 * implementors note says to skip them ("Guest code never gets to see
 * these failures"); everything else ends the perpetual stream.
 */
const TRANSIENT_ACCEPT_FAILURES: ReadonlySet<SocketErrorCode["kind"]> = new Set([
  "connection-aborted",
  "connection-reset",
  "connection-refused",
  "connection-broken",
  "remote-unreachable",
  "timeout",
]);

/** The family's wildcard address, port 0 (tcp listen's implicit bind). */
export function wildcardAddress(family: IpAddressFamily): IpSocketAddress {
  return family === "ipv4"
    ? { kind: "ipv4", value: { port: 0, address: [0, 0, 0, 0] } }
    : {
      kind: "ipv6",
      value: { port: 0, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], scopeId: 0 },
    };
}

/**
 * Abandon tcp send's input when the operation fails: a lifted `Stream`
 * handle is dropped so the guest's writer settles ("reader went away")
 * instead of parking forever; other producer shapes are cleaned up by the
 * iteration protocol itself (`for await`'s abrupt-exit `return()`).
 */
function dropSendSource(data: TcpSendSource): void {
  if (data instanceof Stream) data.drop();
}
