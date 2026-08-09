// `wasi:filesystem@0.2` — types (minimal), preopens
// (contracts/embedder-api.md §"WASI examination", filesystem scope: "types
// (minimal: descriptor resource type constructible-never, error-code),
// preopens (get-directories -> [])").
//
// Leaf inventory mined from `engine-go/main.wasm` (componentize-go's p2
// baseline carries the full filesystem surface even though the guest never
// gets a real directory): `descriptor` and `directory-entry-stream` resource
// TYPES, several `[method]descriptor.*` leaves, `filesystem-error-code`,
// `preopens#get-directories`.

/**
 * `wasi:filesystem/types.descriptor` — constructible-never.
 *
 * `preopens#get-directories` always returns `[]` (below), so no `descriptor`
 * instance can ever reach a guest through this shim; the class exists only
 * so the resource *type* is a legal, structurally-typeable import target.
 * Every method throws if somehow reached — loud, not a silent wrong answer —
 * because reaching one would mean a caller found a descriptor this shim never
 * handed out.
 */
export class Descriptor {
  constructor() {
    throw new TypeError(
      "wasi:filesystem/types.descriptor is never constructed by this shim " +
        "(preopens#get-directories always returns [] — CONTRACT: " +
        "contracts/embedder-api.md 'WASI examination' filesystem scope calls " +
        "the type 'constructible-never')",
    );
  }
  #unreachable(method: string): never {
    throw new TypeError(
      `wasi:filesystem/types#[method]descriptor.${method}: unreachable — ` +
        `no descriptor instance can exist (preopens is empty)`,
    );
  }
  getFlags(): never {
    return this.#unreachable("get-flags");
  }
  getType(): never {
    return this.#unreachable("get-type");
  }
  stat(): never {
    return this.#unreachable("stat");
  }
  statAt(): never {
    return this.#unreachable("stat-at");
  }
  openAt(): never {
    return this.#unreachable("open-at");
  }
  readViaStream(): never {
    return this.#unreachable("read-via-stream");
  }
  writeViaStream(): never {
    return this.#unreachable("write-via-stream");
  }
  appendViaStream(): never {
    return this.#unreachable("append-via-stream");
  }
  metadataHashAt(): never {
    return this.#unreachable("metadata-hash-at");
  }
}

/** `wasi:filesystem/types.directory-entry-stream` — same rationale as `Descriptor`. */
export class DirectoryEntryStream {}

/** `wasi:filesystem@0.2` provider fragment (track key). */
export function filesystem(): { imports: Record<string, unknown> } {
  return {
    imports: {
      "wasi:filesystem/types@0.2": {
        Descriptor,
        DirectoryEntryStream,
        // `filesystem-error-code: func(err: borrow<error>) -> option<error-code>`
        // — this shim's `wasi:io/error` never produces a filesystem-specific
        // error, so downcasting always fails (`none` -> `undefined`).
        filesystemErrorCode: (_err: unknown): undefined => undefined,
      },
      "wasi:filesystem/preopens@0.2": {
        // No preopened directories: consumer guests that never touch the
        // filesystem (the corpus under test) link this leaf but never call
        // a descriptor method.
        getDirectories: (): [Descriptor, string][] => [],
      },
    },
  };
}
