// Plain-vs-jspi equivalence across every lower/lift ABI combination.
//
// `async/cross-abi-calls.wast` exercises all four combinations (sync/async
// lower x sync/async lift) at 4, 5 and 17 params and 1, 16 and 17 results --
// i.e. both the flat and the spilled-through-retptr shapes. Running each
// export in BOTH suspension modes and requiring identical outcomes is a much
// sharper instrument than a pass/fail suite run: plain mode is the reference
// (49/49 green), so any divergence localizes a jspi-path defect to a single
// export name.
//
// It earned its place. It is what caught Fix 1 (M2): the callee's `promising`
// wrap made an async-lowered call into a SYNC-lifted callee report its subtask
// as STARTED when an unwrapped run reported RETURNED, and the six
// `async-calls-sync-*` exports diverged while all others matched exactly.
// A suite run showed only "6 RuntimeError: unreachable" with no hint of shape.
//
// TARGET: zero divergences. CURRENT: six, all `async-calls-sync-*` -- an
// async-lowered call into a sync-lifted callee. Cause (proven, see the M2
// report): the FACT callee is `promising`-wrapped so that a callee which
// blocks can suspend, but `enterWasm` returns a Promise unconditionally, so a
// callee that would have completed eagerly reports its subtask STARTED where
// an unwrapped run reports RETURNED. There is no per-CALL discriminator: the
// same wrap is required by callees that do block. The fix is to not wrap a
// callee that CANNOT block -- a per-callee-instance property derived from the
// plan (does its code import any blocking trampoline?), which does not exist
// yet.
//
// So this pins the exact known-divergent set rather than asserting zero. It
// fails if any OTHER export starts diverging (the regression this guards) and
// equally if one of these six is fixed without shrinking the list (the
// prompt to tighten). Delete entries as they are fixed; the goal is an empty
// list and a plain `length === 0` assertion.
import { assert } from "./asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";

const root = new URL("../../../", import.meta.url);

async function readIfPresent(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

const shimWasm = await readIfPresent(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
const componentWasm = await readIfPresent(
  "harness/generated/async/cross-abi-calls.0.wasm",
);
let fields: string[] = [];
try {
  const spec = JSON.parse(
    await Deno.readTextFile(
      new URL("harness/generated/async/cross-abi-calls.json", root),
    ),
  );
  fields = [
    ...new Set(
      (spec.commands as { action?: { field?: string } }[])
        .filter((c) => c.action?.field)
        .map((c) => c.action!.field!),
    ),
  ];
} catch { /* corpus absent; handled by `ready` below */ }

const ready = shimWasm !== null && componentWasm !== null && fields.length > 0;
if (!ready) {
  console.warn(
    "SKIP cross-abi differential: missing " +
      (shimWasm === null
        ? "translator_shim.wasm (cargo build -p translator-shim --release " +
          "--target wasm32-unknown-unknown)"
        : "harness/generated (cargo run -p testgen)"),
  );
}

Deno.test({
  name: "cross-abi: plain and jspi agree on every export (0 divergences)",
  ignore: !ready,
  fn: async () => {
    const translator = await Translator.create(shimWasm!);

    // A fresh instance per call: the .wast re-instantiates for each command,
    // and sharing one instance across exports would let an earlier call's
    // state decide a later one's outcome.
    const call = async (field: string, jspi: boolean): Promise<string> => {
      const { plan, adapters } = translator.translate(componentWasm!);
      const handle = await instantiateComponent({
        plan,
        componentBytes: componentWasm!,
        adapters,
        jspi,
      });
      try {
        return `ok ${JSON.stringify(await (handle.exports[field] as () => unknown)())}`;
      } catch (e) {
        // Compare the failure TEXT too: "both threw" is not agreement if they
        // threw for different reasons.
        return `threw ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    // Known-divergent, each for the single cause documented above.
    const KNOWN_DIVERGENT = new Set([
      "async-calls-sync-4-param",
      "async-calls-sync-5-param",
      "async-calls-sync-17-param",
      "async-calls-sync-1-result",
      "async-calls-sync-16-result",
      "async-calls-sync-17-result",
    ]);
    const divergences: string[] = [];
    const unexpectedlyAgreeing: string[] = [];
    for (const field of fields) {
      const plain = await call(field, false);
      const jspi = await call(field, true);
      if (plain !== jspi) {
        if (!KNOWN_DIVERGENT.has(field)) {
          divergences.push(`${field}\n    plain: ${plain}\n    jspi : ${jspi}`);
        }
      } else if (KNOWN_DIVERGENT.has(field)) {
        unexpectedlyAgreeing.push(field);
      }
    }
    assert(
      divergences.length === 0,
      `plain and jspi disagree on ${divergences.length} export(s) outside the ` +
        `known set:\n  ${divergences.join("\n  ")}`,
    );
    assert(
      unexpectedlyAgreeing.length === 0,
      `these no longer diverge -- remove them from KNOWN_DIVERGENT: ` +
        unexpectedlyAgreeing.join(", "),
    );
  },
});
