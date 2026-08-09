// Embedder conventions layer (contracts/embedder-api.md; PLAN §13/§17, C2).
//
// The host-facing surface: camelCase facades, resource classes on both sides,
// stream/future handles, version-canonical import resolution and the branded
// error model — all built at instantiate time from the plan's type tables, so
// the layer works fully untyped. Bindgen (a separate track) emits compile-time
// types that cast this facade; no generated code participates.

export {
  type ComponentArtifacts,
  type EmbedderInstance,
  type EmbedderOptions,
  instantiate,
  instantiateEmbedder,
} from "./instantiate.ts";

export { type FuncSummary, type ImportLeaf, type PlanLike, requiredImports } from "./imports.ts";

export {
  DroppedError,
  InvalidHandleError,
  NameCollisionError,
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
