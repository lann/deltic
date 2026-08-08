// Conformance runner: executes every testgen-generated JSON command file
// under harness/generated/ and prints a per-directory summary.
//
// Run via `deno task conformance` (regenerates first) or `deno task test`.

import type { WastJson } from "../src/schema.ts";
import { CoreOnlyExecutor } from "../src/executor.ts";
import { runWastJson } from "../src/runner.ts";
import { Summary } from "../src/summary.ts";

const generatedRoot = new URL("../generated/", import.meta.url);
const summary = new Summary();

let manifest: { files: string[] };
try {
  manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.json", generatedRoot)),
  );
} catch {
  Deno.test("harness/generated is missing", () => {
    throw new Error(
      "harness/generated/manifest.json not found - run `deno task gen` " +
        "(or `deno task conformance`) to convert the wast suite first",
    );
  });
  manifest = { files: [] };
}

for (const relPath of manifest.files) {
  const dir = relPath.split("/")[0];
  Deno.test(`conformance ${relPath}`, async () => {
    const doc: WastJson = JSON.parse(
      await Deno.readTextFile(new URL(relPath, generatedRoot)),
    );
    const result = await runWastJson(
      doc,
      (filename) => Deno.readFile(new URL(`${dir}/${filename}`, generatedRoot)),
      new CoreOnlyExecutor(),
    );
    summary.add(dir, result);

    const failures = result.results.filter((r) => r.status === "failed");
    if (failures.length > 0) {
      const lines = failures.map((f) =>
        `  ${doc.source_filename}:${f.line} ${f.type}: ${f.detail}`
      );
      throw new Error(`${failures.length} command(s) failed:\n${lines.join("\n")}`);
    }
  });
}

Deno.test("conformance summary", () => {
  console.log(`\n${summary.format()}\n`);
  const total = summary.total();
  if (total.commands === 0) {
    throw new Error("no commands ran - is harness/generated populated?");
  }
});
