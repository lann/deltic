// Shared fixture plumbing for the embedder-conventions tests: translate a
// guest fixture with the shim and instantiate it behind the conventions layer.

import { Translator } from "../../src/shim/mod.ts";
import {
  type ComponentArtifacts,
  type EmbedderInstance,
  type EmbedderOptions,
  instantiate,
} from "../../src/embedder/mod.ts";

const root = new URL("../../../", import.meta.url);

export async function readArtifact(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

const shimWasm = await readArtifact(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const translator = shimWasm === null ? null : await Translator.create(shimWasm);

/** True when the shim and `rel` are both present; tests skip otherwise. */
export async function haveFixture(rel: string): Promise<boolean> {
  return translator !== null && (await readArtifact(rel)) !== null;
}

export async function artifactsOf(rel: string): Promise<ComponentArtifacts> {
  const componentBytes = (await readArtifact(rel))!;
  const { plan, adapters } = translator!.translate(componentBytes);
  return { plan, componentBytes, adapters };
}

export async function instantiateFixture(
  rel: string,
  imports: Record<string, unknown> = {},
  opts: EmbedderOptions = {},
): Promise<EmbedderInstance> {
  return await instantiate(await artifactsOf(rel), imports, opts);
}

export function guest(name: string): string {
  return `examples/guests/build/${name}.component.wasm`;
}

export function testdata(name: string): string {
  return `crates/translator-shim/testdata/${name}.wasm`;
}

/** Run `f` and return whatever it threw (or undefined). */
export async function caught(f: () => unknown): Promise<unknown> {
  try {
    await f();
  } catch (e) {
    return e;
  }
  return undefined;
}
