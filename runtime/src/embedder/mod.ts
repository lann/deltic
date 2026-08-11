// Embedder conventions layer (contracts/embedder-api.md; docs/milestones.md C2 / docs/consumers.md).
//
// The host-facing surface: camelCase facades, resource classes on both sides,
// stream/future handles, version-canonical import resolution and the branded
// error model — all built at instantiate time from the plan's type tables, so
// the layer works fully untyped. Bindgen (a separate track) emits compile-time
// types that cast this facade; no generated code participates.

export {
  artifactsFromEnvelope,
  type ComponentArtifacts,
  type EmbedderInstance,
  type EmbedderOptions,
  type InstantiateSource,
  type UntranslatedArtifacts,
  instantiate,
  instantiateEmbedder,
} from "./instantiate.ts";

export { type FuncSummary, type ImportLeaf, type PlanLike, requiredImports } from "./imports.ts";

export {
  DroppedError,
  InvalidHandleError,
  NameCollisionError,
  PeerTrappedError,
  Trap,
  WitError,
} from "./errors.ts";

export {
  type Chunk,
  type ElemCodec,
  ErrorContext,
  Future,
  type FutureSource,
  Stream,
  StreamProducerError,
  type StreamSource,
  StreamWriter,
} from "./streams.ts";

export { GuestResource, HostResourceRegistry } from "./resources.ts";

export { camelCase, type LeafName, parseLeafName, pascalCase } from "./casing.ts";

// Per-declaration suspendability (contracts/embedder-api.md §"Functions and
// async", amendment A1): declares that a sync-typed host import may return a
// Promise, parking the calling wasm frame (JSPI engines only).
export { suspending } from "../jspi/suspending.ts";

export {
  asTrackKeySpelling,
  compareSemver,
  ImportRegistrationError,
  ImportResolutionError,
  ImportResolver,
  type ParsedId,
  parseInterfaceId,
  parseSemver,
  type Semver,
  trackKey,
} from "./version.ts";

export {
  type AdapterOptions,
  BorrowScope,
  fromHost,
  toHost,
  type ValueBridge,
} from "./values.ts";
