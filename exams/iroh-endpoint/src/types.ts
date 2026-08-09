// A hand-written TS facade for `polymorph:iroh/endpoint@0.1.0`, transcribed
// from the consumer's WIT (polymorph-iroh/wit/iroh.wit) under
// contracts/embedder-api.md's mapping rules:
//
//   * resource -> PascalCase class, methods camelCase, statics static
//   * every export is Promise-shaped; `result<T, E>` in RETURN position
//     resolves T or rejects `WitError<E>` (so no `{tag}` unwrapping here)
//   * enums -> kebab-case string literal unions; variants -> `{ tag, val }`
//   * `list<u8>` -> Uint8Array; `option<T>` (outermost) -> `T | undefined`
//   * record fields camelCase; option-typed fields are optional properties
//
// This file is types only: bindgen would emit exactly this shape, and the
// embedder facade is fully untyped at runtime, so these are a cast over the
// real instance.

/** `endpoint-id` = `list<u8>` (32 bytes, an Ed25519 public key). */
export type EndpointId = Uint8Array;

export interface CustomAddr {
  id: bigint;
  data: Uint8Array;
}

export type TransportAddr =
  | { tag: "relay"; val: string }
  | { tag: "ip"; val: string }
  | { tag: "webrtc"; val: string }
  | { tag: "custom"; val: CustomAddr };

export interface EndpointAddr {
  endpointId: EndpointId;
  addrs: TransportAddr[];
}

export type ConnectionState = "connecting" | "open" | "closed";

export type PathKind = "relay" | "ip" | "webrtc";

/** `polymorph:iroh/types@0.1.0`'s `error` variant. */
export type IrohError =
  | { tag: "closed" }
  | { tag: "reset"; val: string }
  | { tag: "connect-failed"; val: string }
  | { tag: "invalid-argument"; val: string }
  | { tag: "other"; val: string };

export interface EndpointOptions {
  alpns: Uint8Array[];
  /** `option<string>`: absent = no home relay. */
  relayUrl?: string;
  /** `option<string>`: absent = bind no UDP socket (the browser profile). */
  udpBindAddr?: string;
  webrtc: boolean;
}

export interface SendStream {
  write(bytes: Uint8Array): Promise<void>;
  /** Sync in WIT, Promise-shaped as an export (embedder-api "Functions and async"). */
  finish(): Promise<void>;
  reset(code: number): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface RecvStream {
  /** `result<option<list<u8>>, error>`: resolves `undefined` at the peer's FIN. */
  read(max: number): Promise<Uint8Array | undefined>;
  stop(code: number): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface Connection {
  peer(): Promise<EndpointId>;
  alpn(): Promise<Uint8Array>;
  state(): Promise<ConnectionState>;
  path(): Promise<PathKind>;
  openBi(): Promise<[SendStream, RecvStream]>;
  openUni(): Promise<SendStream>;
  acceptBi(): Promise<[SendStream, RecvStream]>;
  acceptUni(): Promise<RecvStream>;
  close(code: number, reason: string): Promise<void>;
  waitClosed(): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface Endpoint {
  id(): Promise<EndpointId>;
  directAddr(): Promise<string | undefined>;
  connect(addr: EndpointAddr, alpn: Uint8Array): Promise<Connection>;
  accept(): Promise<Connection>;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface EndpointClass {
  bind(options: EndpointOptions): Promise<Endpoint>;
}

/** The shape of `instance.exports["polymorph:iroh/endpoint@0.1.0"]`. */
export interface IrohEndpointExports {
  Endpoint: EndpointClass;
}
