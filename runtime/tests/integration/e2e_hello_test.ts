// M0 end-to-end integration (PLAN.md §13 M0 exit criterion): the full-JS
// pipeline — translator shim (wasm32, running under Deno) -> plan v0 ->
// TS plan executor -> typed call -> correct result — against the real
// wit-bindgen `hello` guest (strings, realloc, post-return).
//
// Requires build artifacts (both produced from source in this repo):
//   - target/wasm32-unknown-unknown/release/translator_shim.wasm
//       cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   - examples/guests/build/hello.component.wasm
//       ./examples/build.sh

import { assertEq, assertTrap } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const root = new URL("../../../", import.meta.url);

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

Deno.test("hello: full pipeline shim -> plan -> executor -> greet()", async () => {
  const translator = await Translator.create(shimWasm);
  const { plan, adapters } = translator.translate(helloWasm);

  assertEq(plan.formatVersion, 0);
  assertEq(plan.producer.wasmtimeEnviron, "47.0.3");
  assertEq(adapters.size, 0); // no cross-component links in hello

  const component = await instantiateComponent({
    plan,
    componentBytes: helloWasm,
    adapters,
  });

  const greet = component.exports.greet as (name: string) => string;
  assertEq(typeof greet, "function");

  // The exact fixture output (examples/guests/hello/src/lib.rs).
  assertEq(greet("component model"), "Hello, component model!");

  // post-return (cabi_post_greet) ran after result copy-out.
  assertEq(component.stats.postReturnsRun, 1);
  assertEq(component.stats.liftedCalls, 1);
  assertEq(component.stats.tasksResolved, 1);

  // Reentrance gates released after the sync call resolved.
  const inst = component.componentInstances[0];
  assert(inst.mayEnter, "may_enter must be restored after call");
  assert(inst.mayLeave, "may_leave must be restored after call");
  assertEq(inst.flags.value, 1);

  // The instance stays healthy across further calls (post-return freed the
  // previous return area; realloc/memory views survive growth).
  assertEq(greet(""), "Hello, !");
  assertEq(
    greet("a".repeat(200_000)), // forces realloc traffic + memory.grow
    `Hello, ${"a".repeat(200_000)}!`,
  );
  assertEq(component.stats.postReturnsRun, 3);
});

Deno.test("hello: plan determinism (translate twice, byte-identical)", async () => {
  const translator = await Translator.create(shimWasm);
  const first = translator.translateRaw(helloWasm);
  const second = translator.translateRaw(helloWasm);
  assertEq(first === second, true);

  // Also across translator instances (fresh wasm heap layout).
  const translator2 = await Translator.create(shimWasm);
  assertEq(translator2.translateRaw(helloWasm) === first, true);
});

Deno.test("hello: executor validates formatVersion and hash", async () => {
  const translator = await Translator.create(shimWasm);
  const { plan, adapters } = translator.translate(helloWasm);

  // formatVersion mismatch fails fast.
  const bumped = { ...plan, formatVersion: 1 };
  let failed = "";
  try {
    await instantiateComponent({
      plan: bumped,
      componentBytes: helloWasm,
      adapters,
    });
  } catch (e) {
    failed = String(e);
  }
  assert(failed.includes("formatVersion"), `got: ${failed}`);

  // Component-bytes mismatch (hash check) fails fast.
  const tampered = helloWasm.slice();
  tampered[tampered.length - 1] ^= 0xff;
  failed = "";
  try {
    await instantiateComponent({
      plan,
      componentBytes: tampered,
      adapters,
    });
  } catch (e) {
    failed = String(e);
  }
  assert(failed.includes("sha256"), `got: ${failed}`);
});

Deno.test("task model: reentrance gate blocks concurrent entry", async () => {
  const translator = await Translator.create(shimWasm);
  const { plan, adapters } = translator.translate(helloWasm);
  const component = await instantiateComponent({
    plan,
    componentBytes: helloWasm,
    adapters,
  });
  const greet = component.exports.greet as (name: string) => string;
  greet("warm-up");

  // Simulate an in-progress activation of the same instance, as a
  // transitive call back into it would observe (PLAN.md §4.3 item 4: the
  // gates are ours to enforce; the engine permits reentry the CM forbids).
  const inst = component.componentInstances[0];
  inst.enter();
  try {
    assertTrap(() => greet("reentrant"), "reentrant call");
  } finally {
    inst.leave();
  }
  // Gate released: calls work again.
  assertEq(greet("after"), "Hello, after!");

  // Host input of the wrong JS type must not wedge the gates either. (It
  // surfaces as a host-side error, not a CM trap — cabi asserts host-value
  // validity per the open question in runtime/README.md.)
  let threw = false;
  try {
    greet(123 as unknown as string);
  } catch {
    threw = true;
  }
  assert(threw, "number lowered as string must fail");
  assert(inst.mayEnter, "gate must recover after a failed call");
  assertEq(greet("recovered"), "Hello, recovered!");
});
