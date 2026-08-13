// `wasi:sockets/types@0.3` — the UDP direct path, served for real over
// `Deno.listenDatagram`. À la carte (issue #4): this module is a separate
// export (`@deltic/wasi-shims/sockets`), never merged into `wasiShims()` —
// the baseline package stays host-agnostic web-platform code, while this
// fragment is Deno-native by nature (browsers have no UDP; wasmtime owns
// the native story). Consumers that want the direct path spread it in:
//
//   instantiate(artifacts, { ...wasiShims(), ...sockets().imports })
//
// Adopted from polymorph-components/polymorph-iroh#69 (that host's exam
// drives it over loopback QUIC); divergences from the adopted code are
// the track key (`@0.3`, per this package's conventions — one provider
// serves every 0.3.x), the fragment-scoped `onCall` hook replacing a
// module-global call log (a published provider must not grow a string per
// datagram by default), and `globalThis`-based feature detection (the
// module evaluates and answers honestly on hosts with no `Deno` at all).
//
// The resource shape below is the one the iroh endpoint component actually
// links (transcribed from the artifact's own embedded WIT, which agrees
// with upstream `wit/deps/wasi-sockets`):
//
//   resource udp-socket {
//     create: static func(address-family: ip-address-family) -> result<udp-socket, error-code>;
//     bind: func(local-address: ip-socket-address) -> result<_, error-code>;
//     send: async func(data: list<u8>, remote-address: option<ip-socket-address>) -> result<_, error-code>;
//     receive: async func() -> result<tuple<list<u8>, ip-socket-address>, error-code>;
//     get-local-address: func() -> result<ip-socket-address, error-code>;
//   }
//
// That five-function surface is also exactly what this module implements:
// the runtime dispatches only the functions a component's plan imports, so
// the unlinked remainder of the WIT resource (connect/disconnect, socket
// options) stays absent, and a future guest that links more fails loudly
// with a trap naming the missing method rather than riding an untested
// emulation.
//
// The behavioral yardstick is wasmtime-wasi's p3 provider (the consumers'
// wasmtime hosts serve the same guests through it): the same 64 KiB
// datagram ceiling, the same state machine (`bind` once from unbound;
// `receive` and `get-local-address` demand a bound socket; `send` to a
// remote implicitly binds an unbound socket to a wildcard address; an
// omitted `send` remote is `invalid-argument` on this connectionless
// surface), and the same address-family validation (an IPv4-mapped or
// deprecated IPv4-compatible IPv6 address never crosses a family
// boundary). Recorded divergences, both rooted in `Deno.listenDatagram`
// exposing no socket options:
//
//   * scope-id: a non-zero IPv6 `scope-id` fails `not-supported` (Deno
//     hostnames cannot carry a zone; wasmtime binds it).
//   * v6-only: wasmtime sets IPV6_V6ONLY on IPv6 sockets; Deno leaves the
//     OS default, so an `::` wildcard bind on Linux is dual-stack and may
//     receive IPv4 traffic, surfaced as IPv4-mapped sender addresses —
//     which is also why the address codec parses the `::ffff:a.b.c.d`
//     spelling.
//
// When `Deno.listenDatagram` is absent (no `Deno` global, or the `net`
// unstable feature off — it needs `--unstable-net` or deno.json
// `"unstable": ["net"]`), `create` fails `error-code.not-supported` — the
// honest capability answer a UDP-less deployment gives.

import { ComponentException } from "@deltic/runtime/embedder";

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

// --- the unstable Deno surface, typed structurally ---------------------------
//
// `Deno.listenDatagram` is unstable, so its declarations are absent from
// the stable type surface this package checks against; and on a non-Deno
// host the `Deno` global is absent entirely. Both are handled the same
// way: the surface is typed structurally here and looked up through
// `globalThis` at call time, so the module never assumes the API at
// evaluation and `create` can answer `not-supported` truthfully.

/** The address shape `Deno.listenDatagram` speaks (structural `Deno.NetAddr`). */
export interface NetAddr {
  transport?: string;
  hostname: string;
  port: number;
}

interface DatagramConn {
  readonly addr: NetAddr;
  send(p: Uint8Array, addr: NetAddr): Promise<number>;
  receive(p?: Uint8Array): Promise<[Uint8Array, NetAddr]>;
  close(): void;
}

type ListenDatagram = (options: {
  transport: "udp";
  hostname: string;
  port: number;
}) => DatagramConn;

function denoNamespace(): Record<string, unknown> | undefined {
  const deno = (globalThis as { Deno?: unknown }).Deno;
  return typeof deno === "object" && deno !== null
    ? (deno as Record<string, unknown>)
    : undefined;
}

function listenDatagram(): ListenDatagram | undefined {
  const fn = denoNamespace()?.listenDatagram;
  return typeof fn === "function" ? (fn as ListenDatagram) : undefined;
}

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
function isValidAddressFamily(family: IpAddressFamily, addr: IpSocketAddress): boolean {
  if (family === "ipv4") return addr.kind === "ipv4";
  return addr.kind === "ipv6" &&
    !isV4MappedV6(addr.value.address) &&
    !isDeprecatedV4CompatibleV6(addr.value.address);
}

function isUnspecified(addr: IpSocketAddress): boolean {
  if (addr.kind === "ipv4") return addr.value.address.every((o) => o === 0);
  return addr.value.address.every((g) => g === 0);
}

// --- error mapping ------------------------------------------------------------

/** `e instanceof Deno.errors[name]`, tolerating hosts/versions lacking the class. */
function isDenoError(e: unknown, name: string): boolean {
  const errors = denoNamespace()?.errors;
  if (typeof errors !== "object" || errors === null) return false;
  const cls = (errors as Record<string, unknown>)[name];
  return typeof cls === "function" &&
    e instanceof (cls as new () => Error);
}

/**
 * Map a platform failure onto the WIT `error-code` vocabulary, mirroring
 * wasmtime-wasi's io-error table where Deno exposes the distinction. An
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
  // EMSGSIZE surfaces as a plain Error, not a Deno.errors class.
  if (/message too long/i.test(message)) return err({ kind: "datagram-too-large" });
  if (e instanceof TypeError) return err({ kind: "invalid-argument" });
  return err({ kind: "other", value: message });
}

// --- the fragment --------------------------------------------------------------

export interface SocketsOptions {
  /**
   * Observe every `wasi:sockets` entry point the guest reaches, in call
   * order (`"udp-socket.create"`, `"udp-socket.bind"`, …). For host-side
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
  send(data: Uint8Array, remoteAddress: IpSocketAddress | undefined): Promise<void>;
  receive(): Promise<[Uint8Array, IpSocketAddress]>;
  getLocalAddress(): IpSocketAddress;
  [Symbol.dispose](): void;
}

/** The `udp-socket` resource class a fragment carries. */
export interface UdpSocketClass {
  create(addressFamily: IpAddressFamily): UdpSocket;
}

export const SOCKETS_TYPES_INTERFACE = "wasi:sockets/types@0.3";

/** What `sockets()` returns: the imports fragment plus the fragment's class. */
export interface SocketsShim {
  imports: Record<string, unknown>;
  /** This fragment's resource class (exposed for direct/test use). */
  UdpSocket: UdpSocketClass;
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

    private constructor(family: IpAddressFamily) {
      this.#family = family;
    }

    static create(addressFamily: IpAddressFamily): UdpSocket {
      onCall("udp-socket.create");
      if (listenDatagram() === undefined) {
        throw componentError(
          { kind: "not-supported" },
          "udp-socket.create: this host provides no datagram sockets " +
            "(Deno.listenDatagram is unavailable; it needs the `net` unstable feature)",
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
    }

    async send(data: Uint8Array, remoteAddress: IpSocketAddress | undefined): Promise<void> {
      onCall("udp-socket.send");
      if (data.length > MAX_UDP_DATAGRAM_SIZE) {
        throw componentError(
          { kind: "datagram-too-large" },
          `udp-socket.send: ${data.length} bytes exceeds the ${MAX_UDP_DATAGRAM_SIZE}-byte ceiling`,
        );
      }
      // This surface has no `connect`, so the socket is never in connected
      // mode and an omitted remote has no destination to fall back to
      // (POSIX EDESTADDRREQ).
      if (remoteAddress === undefined) {
        throw componentError(
          { kind: "invalid-argument" },
          "udp-socket.send: no remote-address, and the socket is not connected",
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
      // A fresh buffer per call: concurrent receives on one socket are legal,
      // and Deno's default buffer size is not contractual.
      const buffer = new Uint8Array(MAX_UDP_DATAGRAM_SIZE);
      try {
        const [payload, from] = await this.#conn.receive(buffer);
        return [payload, parseNetAddr(from)];
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
          "udp-socket: Deno.listenDatagram disappeared after create",
        );
      }
      return listen(opts);
    }
  }

  return {
    imports: { [SOCKETS_TYPES_INTERFACE]: { UdpSocket } },
    UdpSocket,
  };
}
