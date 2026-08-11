// The embedder-facing error model (contracts/embedder-api.md §"Error model").
//
// The canonical definitions live in `@deltic/protocol` since amendment A8 —
// this module is the unchanged import path for them (every existing
// `from "./errors.ts"` / `@deltic/runtime/embedder` import keeps working) plus
// the runtime-local `NameCollisionError`, which never crosses a copy boundary
// (it is raised while BUILDING a facade, before any value exists) and
// therefore carries no brand: the A8 table's omissions are deliberate.
//
// Recognition at the runtime's own boundaries is by BRAND, not class: use the
// `is*` predicates re-exported below, never `instanceof`, for any value that
// arrives from embedder code (issue #83).

export {
  DroppedError,
  InvalidHandleError,
  isDroppedError,
  isInvalidHandleError,
  isPeerTrappedError,
  isStreamProducerError,
  isTrap,
  isWitError,
  PeerTrappedError,
  Trap,
  WitError,
} from "@deltic/protocol";

/**
 * Two WIT labels in one scope camelCase to the same JS name.
 *
 * A footgun is a design defect (contract principle 2): silently letting one
 * field/flag/function shadow another would corrupt values at the boundary with
 * no diagnostic anywhere. Refused at facade build instead.
 */
export class NameCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameCollisionError";
  }
}
