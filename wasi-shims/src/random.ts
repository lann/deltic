// `wasi:random@0.2` — random, insecure, insecure-seed
// (contracts/embedder-api.md §"WASI examination"; leaves confirmed against
// `engine-go/main.wasm`'s import surface: `get-random-bytes`).

export interface RandomOptions {
  /** Override the deterministic default `insecure-seed` value. */
  insecureSeed?: readonly [bigint, bigint];
}

function randomBytes(len: bigint): Uint8Array {
  const out = new Uint8Array(Number(len));
  crypto.getRandomValues(out);
  return out;
}

function randomU64(): bigint {
  const out = new Uint8Array(8);
  crypto.getRandomValues(out);
  return new DataView(out.buffer).getBigUint64(0, true);
}

/**
 * A fixed default: `wasi:random/insecure-seed` is explicitly documented (WIT
 * doc comment, io.wit deps) as allowed to be entirely deterministic — it
 * exists to seed hash-map DoS resistance, not for cryptographic use. This
 * shim defaults to a fixed, obviously-synthetic pair (documented here as
 * exactly that) so runs are reproducible; pass `insecureSeed` to override.
 */
const DEFAULT_INSECURE_SEED: readonly [bigint, bigint] = [0n, 1n];

/** `wasi:random@0.2` provider fragment (track key). */
export function random(options: RandomOptions = {}): { imports: Record<string, unknown> } {
  const seed = options.insecureSeed ?? DEFAULT_INSECURE_SEED;
  return {
    imports: {
      "wasi:random/random@0.2": {
        getRandomBytes: randomBytes,
        getRandomU64: randomU64,
      },
      // "insecure" only means "not required to be a CSPRNG" — it is still
      // wired to the real CSPRNG here for simplicity; only `insecure-seed`
      // is deliberately, documentedly predictable.
      "wasi:random/insecure@0.2": {
        getInsecureRandomBytes: randomBytes,
        getInsecureRandomU64: randomU64,
      },
      "wasi:random/insecure-seed@0.2": {
        insecureSeed: (): readonly [bigint, bigint] => seed,
      },
    },
  };
}
