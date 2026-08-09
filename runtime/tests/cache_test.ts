// Artifact cache tests (docs/architecture.md §10, M3-B dispatch).
//
// Requires build artifacts (both produced from source in this repo), same
// as runtime/tests/integration/e2e_hello_test.ts:
//   - target/wasm32-unknown-unknown/release/translator_shim.wasm
//       cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   - examples/guests/build/{hello,test-suite}.component.wasm
//       ./examples/build.sh

import { assertEq } from "./support/asserts.ts";
import { Translator } from "../src/shim/mod.ts";
import { instantiateComponent } from "../src/exec/mod.ts";
import {
  type ArtifactCache,
  CACHE_LAYOUT_VERSION,
  dirCache,
  keyFor,
  keyHex,
  translateCached,
  type TranslatorLike,
  webCache,
} from "../src/cache/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const root = new URL("../../", import.meta.url);

async function readArtifact(rel: string, hint: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    throw new Error(`missing build artifact ${rel} — run: ${hint}`);
  }
}

const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  "cargo build -p translator-shim --release --target wasm32-unknown-unknown",
);
const helloWasm = await readArtifact(
  "examples/guests/build/hello.component.wasm",
  "./examples/build.sh",
);
const testSuiteWasm = await readArtifact(
  "examples/guests/build/test-suite.component.wasm",
  "./examples/build.sh",
);

/** Wraps a real `Translator`, counting `translateRaw` calls, so tests can
 * assert a cache hit never touches the shim (`TranslatorLike` is structural
 * — see cache/core.ts — so this substitutes cleanly for `translateCached`). */
class SpyTranslator implements TranslatorLike {
  #inner: Translator;
  translateCalls = 0;

  constructor(inner: Translator) {
    this.#inner = inner;
  }

  get buildHash(): string | null {
    return this.#inner.buildHash;
  }

  translateRaw(bytes: Uint8Array): string {
    this.translateCalls++;
    return this.#inner.translateRaw(bytes);
  }
}

async function tmpDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "artifact-cache-test-" });
}

// ---------------------------------------------------------------------------
// Round-trip: translate, put, get, instantiate FROM CACHE (translator spy
// proves the shim is never touched on the hit path), exports still work.
// ---------------------------------------------------------------------------

async function roundTrip(cache: ArtifactCache, label: string) {
  const translator = await Translator.create(shimWasm);
  const spy = new SpyTranslator(translator);

  const first = await translateCached(spy, helloWasm, cache);
  assertEq(first.fromCache, false, `${label}: first call is a miss`);
  assertEq(spy.translateCalls, 1, `${label}: miss invokes the shim once`);

  // Fresh spy over a fresh translator instance so a hit truly can't be
  // satisfied by some in-process memo on the translator itself.
  const spy2 = new SpyTranslator(await Translator.create(shimWasm));
  const second = await translateCached(spy2, helloWasm, cache);
  assertEq(second.fromCache, true, `${label}: second call is a hit`);
  assertEq(spy2.translateCalls, 0, `${label}: hit never invokes the shim`);

  assertEq(
    JSON.stringify(second.plan),
    JSON.stringify(first.plan),
    `${label}: cached plan matches the freshly-translated one`,
  );

  const component = await instantiateComponent({
    plan: second.plan,
    componentBytes: helloWasm,
    adapters: second.adapters,
  });
  const greet = component.exports.greet as (name: string) => string;
  assertEq(greet("cache"), "Hello, cache!", `${label}: cached artifacts still work`);
}

Deno.test("dirCache: round-trip, cache hit skips the translator entirely", async () => {
  const cache = dirCache(await tmpDir());
  await roundTrip(cache, "dirCache");
});

Deno.test("webCache: round-trip, cache hit skips the translator entirely", async () => {
  const cache = webCache(`artifact-cache-test-${crypto.randomUUID()}`);
  await roundTrip(cache, "webCache");
});

// ---------------------------------------------------------------------------
// Key sensitivity.
// ---------------------------------------------------------------------------

Deno.test("dirCache: different component bytes -> miss", async () => {
  const cache = dirCache(await tmpDir());
  const translator = await Translator.create(shimWasm);
  await translateCached(translator, helloWasm, cache);

  const tampered = helloWasm.slice();
  tampered[tampered.length - 1] ^= 0xff;
  const key = await keyFor(translator, tampered);
  assertEq(await cache.get(key), null);
});

Deno.test("dirCache: different translator build hash -> miss", async () => {
  const cache = dirCache(await tmpDir());
  const translator = await Translator.create(shimWasm);
  await translateCached(translator, helloWasm, cache);

  const realKey = await keyFor(translator, helloWasm);
  const spoofedKey = { ...realKey, translatorBuildHash: "0".repeat(64) };
  assertEq(await cache.get(spoofedKey), null);
});

Deno.test("dirCache: different feature flags -> miss", async () => {
  const cache = dirCache(await tmpDir());
  const translator = await Translator.create(shimWasm);
  await translateCached(translator, helloWasm, cache, { features: ["a"] });

  const keyA = await keyFor(translator, helloWasm, ["a"]);
  const keyB = await keyFor(translator, helloWasm, ["b"]);
  assert(await cache.get(keyA) !== null, "same features -> hit");
  assertEq(await cache.get(keyB), null);
});

Deno.test("dirCache: feature flag order is insensitive (key composition)", async () => {
  const translator = await Translator.create(shimWasm);
  const k1 = await keyFor(translator, helloWasm, ["a", "b"]);
  const k2 = await keyFor(translator, helloWasm, ["b", "a"]);
  assertEq(await keyHex(k1), await keyHex(k2));
});

Deno.test("dirCache: corrupted stored plan.json -> miss + eviction", async () => {
  const dir = await tmpDir();
  const cache = dirCache(dir);
  const translator = await Translator.create(shimWasm);
  const key = await keyFor(translator, helloWasm);
  await translateCached(translator, helloWasm, cache);

  const hex = await keyHex(key);
  await Deno.writeTextFile(`${dir}/${hex}/plan.json`, "{ not json");

  assertEq(await cache.get(key), null);
  // Evicted: the entry directory is gone, not just failing to parse.
  let stillThere = true;
  try {
    await Deno.stat(`${dir}/${hex}`);
  } catch {
    stillThere = false;
  }
  assertEq(stillThere, false, "corrupted entry must be evicted");
});

Deno.test("dirCache: unknown layout version -> miss (no crash)", async () => {
  const dir = await tmpDir();
  const cache = dirCache(dir);
  const translator = await Translator.create(shimWasm);
  const key = await keyFor(translator, helloWasm);
  await translateCached(translator, helloWasm, cache);

  const hex = await keyHex(key);
  const metaPath = `${dir}/${hex}/meta.json`;
  const meta = JSON.parse(await Deno.readTextFile(metaPath));
  meta.layoutVersion = CACHE_LAYOUT_VERSION + 1;
  await Deno.writeTextFile(metaPath, JSON.stringify(meta));

  assertEq(await cache.get(key), null);
});

// ---------------------------------------------------------------------------
// Determinism guard (opt-in, tests only per dispatch): translate twice,
// byte-identical envelopes, before trusting/storing the result.
// ---------------------------------------------------------------------------

Deno.test("translateCached: determinism guard passes on a real fixture", async () => {
  const cache = dirCache(await tmpDir());
  const translator = await Translator.create(shimWasm);
  const result = await translateCached(translator, helloWasm, cache, {
    verifyDeterminism: true,
  });
  assertEq(result.fromCache, false);
});

Deno.test("translateCached: determinism guard trips on a non-deterministic translator", async () => {
  const translator = await Translator.create(shimWasm);
  let call = 0;
  const flaky: TranslatorLike = {
    buildHash: translator.buildHash,
    translateRaw(bytes: Uint8Array): string {
      call++;
      const json = translator.translateRaw(bytes);
      // Perturb the second call only, simulating a nondeterminism bug.
      return call === 2 ? json + " " : json;
    },
  };
  const cache = dirCache(await tmpDir());
  let threw = false;
  try {
    await translateCached(flaky, helloWasm, cache, { verifyDeterminism: true });
  } catch {
    threw = true;
  }
  assert(threw, "determinism guard must reject a nondeterministic translator");
});

// ---------------------------------------------------------------------------
// Perf sanity: cached load skips translation (coarse timing).
// ---------------------------------------------------------------------------

Deno.test("dirCache: cached load of the biggest fixture skips translation (timing)", async () => {
  const cache = dirCache(await tmpDir());
  const translator = await Translator.create(shimWasm);

  const t0 = performance.now();
  await translateCached(translator, testSuiteWasm, cache);
  const translateMs = performance.now() - t0;

  const t1 = performance.now();
  const cached = await translateCached(translator, testSuiteWasm, cache);
  const cacheMs = performance.now() - t1;

  assertEq(cached.fromCache, true);
  // Coarse: the cache path (dir reads only) must not be slower than the
  // real translate path. Not a tight bound — just a sanity check that the
  // cache is actually short-circuiting work, not silently re-translating.
  assert(
    cacheMs <= translateMs,
    `cache path (${cacheMs}ms) should not exceed translate path (${translateMs}ms)`,
  );
});

// ---------------------------------------------------------------------------
// webCache: unit-test key/serialization logic against Deno's real Cache API
// (feature-complete in this Deno version — see dispatch: "unit-test the
// key/serialization logic with a Cache API stub"; Deno's native
// implementation serves that role here without a hand-rolled stub, and
// exercises the real code path rather than a mock of it).
// ---------------------------------------------------------------------------

Deno.test("webCache: unavailable Cache API surfaces a named error", async () => {
  const savedDesc = Object.getOwnPropertyDescriptor(globalThis, "caches")!;
  try {
    // `caches` is an accessor property (getter-only) on `globalThis`; a
    // plain assignment throws, so redefine the property instead.
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: undefined,
    });
    const cache = webCache("artifact-cache-unavailable-test");
    const translator = await Translator.create(shimWasm);
    const key = await keyFor(translator, helloWasm);
    let errName = "";
    try {
      await cache.get(key);
    } catch (e) {
      errName = (e as Error).name;
    }
    assertEq(errName, "WebCacheUnavailableError");
  } finally {
    Object.defineProperty(globalThis, "caches", savedDesc);
  }
});

Deno.test("webCache: eviction removes the entry", async () => {
  const cache = webCache(`artifact-cache-evict-test-${crypto.randomUUID()}`);
  const translator = await Translator.create(shimWasm);
  const key = await keyFor(translator, helloWasm);
  await translateCached(translator, helloWasm, cache);
  assert(await cache.get(key) !== null, "present before eviction");
  await cache.evict(key);
  assertEq(await cache.get(key), null);
});
