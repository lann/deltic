// Client for the translator shim's wasm32 C-ABI (crates/translator-shim).
// Platform-neutral: callers provide the shim module/bytes; file loading is
// embedder territory.
//
// C-ABI (see crates/translator-shim/src/lib.rs `cabi`):
//   ts_alloc(len) -> ptr
//   ts_translate(ptr, len, out_len_ptr) -> out_ptr   (out = envelope JSON)
//   ts_dealloc(ptr, len)

import { loadEnvelope, PlanError } from "../plan/loader.ts";
import type { WirePlan } from "../plan/format.ts";

interface ShimExports {
  memory: WebAssembly.Memory;
  ts_alloc(len: number): number;
  ts_dealloc(ptr: number, len: number): void;
  ts_translate(ptr: number, len: number, outLenPtr: number): number;
}

export interface TranslationResult {
  plan: WirePlan;
  /** Adapter artifacts keyed by `plan.modules[].file`. */
  adapters: Map<string, Uint8Array>;
  /** The raw envelope JSON (byte-exact; useful for determinism checks). */
  envelopeJson: string;
}

/** An instantiated translator shim. One instance is reusable across calls. */
export class Translator {
  #exports: ShimExports;
  /**
   * sha256 of the shim wasm bytes this instance was built from, hex-encoded;
   * `null` when constructed from a pre-compiled `WebAssembly.Module` with no
   * bytes available (module identity can't be recovered post-compile).
   *
   * This is the honest translator "build hash" for the artifact cache
   * (docs/architecture.md §10): the wire envelope's `producer` block records
   * `{shimVersion, wasmtimeEnviron, features}`, which does NOT change when
   * the shim wasm is rebuilt from the same source versions (e.g. a local
   * patch or a different toolchain producing different codegen) — see the
   * M3-B dispatch. Digesting the actual bytes is the only sound cache key
   * component for translator identity.
   */
  readonly buildHash: string | null;

  private constructor(instance: WebAssembly.Instance, buildHash: string | null) {
    this.#exports = instance.exports as unknown as ShimExports;
    this.buildHash = buildHash;
    for (const name of ["memory", "ts_alloc", "ts_dealloc", "ts_translate"]) {
      if (!(name in this.#exports)) {
        throw new PlanError(`shim module missing export '${name}'`);
      }
    }
  }

  /** Instantiate from compiled module or raw wasm bytes. */
  static async create(
    source: WebAssembly.Module | Uint8Array,
  ): Promise<Translator> {
    let module: WebAssembly.Module;
    let buildHash: string | null = null;
    if (source instanceof WebAssembly.Module) {
      module = source;
    } else {
      module = await WebAssembly.compile(source.slice().buffer as ArrayBuffer);
      const digest = await crypto.subtle.digest("SHA-256", source.slice().buffer as ArrayBuffer);
      buildHash = Array.from(new Uint8Array(digest)).map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
    }
    const instance = await WebAssembly.instantiate(module, {});
    return new Translator(instance, buildHash);
  }

  /** Translate a component binary into plan v0 + adapter artifacts. */
  translate(componentBytes: Uint8Array): TranslationResult {
    const json = this.translateRaw(componentBytes);
    const { wire, adapters } = loadEnvelope(json);
    return { plan: wire, adapters, envelopeJson: json };
  }

  /** Translate, returning the raw envelope JSON without validation. */
  translateRaw(componentBytes: Uint8Array): string {
    const ex = this.#exports;
    const inPtr = ex.ts_alloc(componentBytes.length);
    new Uint8Array(ex.memory.buffer, inPtr, componentBytes.length).set(
      componentBytes,
    );
    const outLenPtr = ex.ts_alloc(4);
    const outPtr = ex.ts_translate(inPtr, componentBytes.length, outLenPtr);
    // Re-acquire views: translation may have grown (detached) the memory.
    const outLen = new DataView(ex.memory.buffer).getUint32(outLenPtr, true);
    const json = new TextDecoder().decode(
      new Uint8Array(ex.memory.buffer, outPtr, outLen),
    );
    ex.ts_dealloc(outPtr, outLen);
    ex.ts_dealloc(outLenPtr, 4);
    ex.ts_dealloc(inPtr, componentBytes.length);
    return json;
  }
}
