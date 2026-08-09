// Artifact cache — platform-neutral core (PLAN.md §10, layer 1: ours, bytes
// only; nothing here depends on the engine's own compiled-module cache,
// i.e. layer 2).
//
// GOAL: content-address a shim translation by
// `(component sha256, translator build hash, feature flags)` so a reload
// (same component, same shim build, same features) can skip the
// translate-with-the-shim step entirely.
//
// PERSISTED-ARTIFACT-SET DECISION (governing: contracts/plan-format.md
// "Artifact set" + "No duplicate bytes" — plan-format.md:24-31,63-64):
// we persist `plan.json` (the wire `WirePlan`) and the FACT adapter modules
// only. We do NOT persist the original component bytes.
//
// Evidence this is correct, not merely convenient:
//   - plan-format.md is explicit: "The original component binary is the
//     third input at instantiation time; the plan never embeds it" and
//     "Embedded core modules are referenced as `[offset, len)` byte ranges
//     into the original component binary — the executor slices them
//     itself" (decision 3). `instantiateComponent`/`Facade.instantiate`
//     (runtime/src/embedder/instantiate.ts `ComponentArtifacts`) take
//     `componentBytes` as a caller-supplied field *alongside* `plan` and
//     `adapters` — never as something the plan or its loader manufacture.
//   - Operationally: whoever calls `translateCached` already holds the
//     component bytes (that's how they'd have a sha256 to form a cache key
//     in the first place, and how `verifyComponent`'s length check runs
//     without a bytes store at all). Reload use cases (browser page reload,
//     Deno process restart) re-fetch/re-read the *component* from its own
//     source of truth (network, disk) every time; only the *translation*
//     (the expensive shim call) is worth skipping. Storing componentBytes a
//     second time would be pure duplication with no consumer.
//   - `get()` therefore verifies integrity using only the requested
//     `CacheKey.componentSha256` against the value that was true at `put()`
//     time (recorded in the stored metadata and cross-checked against the
//     embedded `plan.component.sha256`) — never against fresh bytes, which
//     this layer never sees.

import type { WirePlan } from "../plan/format.ts";
import { loadEnvelope, PlanError, TranslateError } from "../plan/loader.ts";

/**
 * The minimal surface `translateCached`/`keyFor` need from a translator.
 * Structural (not `Translator` itself) so tests can substitute a spy that
 * proves the shim path was/wasn't exercised, without subclassing the real
 * wasm-backed client.
 */
export interface TranslatorLike {
  readonly buildHash: string | null;
  translateRaw(componentBytes: Uint8Array): string;
}

/** Cache layout version. Bumped on any incompatible on-disk/on-Cache-API
 * schema change; an unrecognized version is read back as a miss (never a
 * crash) so stale caches from an older build self-heal by re-translating. */
export const CACHE_LAYOUT_VERSION = 1;

/** The three-part identity a translation is content-addressed by. */
export interface CacheKey {
  /** hex sha256 of the component bytes (matches `plan.component.sha256`). */
  componentSha256: string;
  /**
   * hex sha256 of the translator (shim) wasm bytes — `Translator.buildHash`.
   * NOT the envelope's `producer.shimVersion`/`wasmtimeEnviron`: those don't
   * change across a shim rebuild with identical pinned versions but
   * different generated code (see `Translator.buildHash` docs).
   */
  translatorBuildHash: string;
  /** wasmparser feature set used, order-insensitive. */
  features: string[];
}

/** What a cache hit returns: enough to instantiate, given the caller's own
 * (already-in-hand) component bytes. */
export interface CachedArtifacts {
  plan: WirePlan;
  /** Adapter artifacts keyed by `plan.modules[].file`, same shape as
   * `TranslationResult.adapters`. */
  adapters: Map<string, Uint8Array>;
}

export interface ArtifactCache {
  get(key: CacheKey): Promise<CachedArtifacts | null>;
  put(key: CacheKey, artifacts: CachedArtifacts): Promise<void>;
  /** Remove a poisoned/stale entry. Cache backends also call this
   * internally on a failed integrity check during `get`. */
  evict(key: CacheKey): Promise<void>;
}

/** On-disk / on-Cache-API metadata envelope stored alongside the plan. */
export interface CacheMeta {
  layoutVersion: number;
  componentSha256: string;
  translatorBuildHash: string;
  features: string[];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The stable cache key string: sha256 over a canonical JSON encoding of the
 * `CacheKey` (features sorted so order never causes a spurious miss).
 */
export async function keyHex(key: CacheKey): Promise<string> {
  const canonical = JSON.stringify({
    componentSha256: key.componentSha256,
    translatorBuildHash: key.translatorBuildHash,
    features: [...key.features].sort(),
  });
  return await sha256Hex(new TextEncoder().encode(canonical));
}

/** Compute the `CacheKey` for a `(translator, componentBytes)` pair. Throws
 * if the translator has no `buildHash` (constructed from a pre-compiled
 * `WebAssembly.Module` with no bytes available — see `Translator.create`). */
export async function keyFor(
  translator: TranslatorLike,
  componentBytes: Uint8Array,
  features: string[] = [],
): Promise<CacheKey> {
  if (translator.buildHash === null) {
    throw new PlanError(
      "artifact cache: translator has no buildHash (constructed from a " +
        "WebAssembly.Module without source bytes); pass raw wasm bytes to " +
        "Translator.create to enable caching",
    );
  }
  return {
    componentSha256: await sha256Hex(componentBytes),
    translatorBuildHash: translator.buildHash,
    features,
  };
}

export interface TranslateCachedOptions {
  features?: string[];
  /**
   * Opt-in determinism guard (tests only, per dispatch): after a cache miss,
   * translate a second time and assert byte-identical envelope JSON before
   * trusting/storing the result. Throws `Error` on mismatch.
   */
  verifyDeterminism?: boolean;
}

export interface TranslateCachedResult {
  plan: WirePlan;
  adapters: Map<string, Uint8Array>;
  /** Whether this result came from the cache (`true`) or a fresh shim
   * translation (`false`). Exposed for tests/observability; not part of the
   * `ArtifactCache` contract itself. */
  fromCache: boolean;
}

/**
 * Orchestration helper: cache hit -> stored artifacts, cache miss ->
 * translate with the shim, store, return.
 */
export async function translateCached(
  translator: TranslatorLike,
  componentBytes: Uint8Array,
  cache: ArtifactCache,
  opts: TranslateCachedOptions = {},
): Promise<TranslateCachedResult> {
  const key = await keyFor(translator, componentBytes, opts.features ?? []);

  const hit = await cache.get(key);
  if (hit !== null) {
    return { plan: hit.plan, adapters: hit.adapters, fromCache: true };
  }

  const first = translator.translateRaw(componentBytes);
  if (opts.verifyDeterminism) {
    const second = translator.translateRaw(componentBytes);
    if (first !== second) {
      throw new Error(
        "artifact cache: determinism guard failed — translating the same " +
          "component bytes twice produced different envelopes",
      );
    }
  }
  // loadEnvelope both validates (throws TranslateError for a validation
  // verdict — must propagate uncached, per TranslateError's docs: a
  // validation verdict is a judgment about the *input component*, not
  // something to cache-and-replay) and gives us the split plan/adapters.
  let wire: WirePlan;
  let adapters: Map<string, Uint8Array>;
  try {
    ({ wire, adapters } = loadEnvelope(first));
  } catch (e) {
    if (e instanceof TranslateError) throw e;
    throw e;
  }

  await cache.put(key, { plan: wire, adapters });
  return { plan: wire, adapters, fromCache: false };
}
