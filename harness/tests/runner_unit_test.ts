// Unit tests for the runner + CoreOnlyExecutor over in-memory fixtures.
//
// The official component-model suite contains zero top-level core modules,
// so these fixtures keep the core-module execution path (the only path that
// can execute today) covered. They also pin the environment facts the
// harness design relies on.

import type { WastJson } from "../src/schema.ts";
import { CoreOnlyExecutor } from "../src/executor.ts";
import { runWastJson } from "../src/runner.ts";

// (module) - the empty core module, hand-encoded.
const EMPTY_CORE_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
// Core preamble with a bogus version.
const BAD_VERSION_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 9, 0, 0, 0]);
// (component) - the empty component: core preamble with version 0x0d,
// layer 0x0001.
const EMPTY_COMPONENT = new Uint8Array([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]);

const artifacts = new Map<string, Uint8Array<ArrayBuffer>>([
  ["ok.0.wasm", EMPTY_CORE_MODULE],
  ["bad.0.wasm", BAD_VERSION_MODULE],
  ["comp.0.wasm", EMPTY_COMPONENT],
]);

function load(filename: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = artifacts.get(filename);
  if (bytes === undefined) throw new Error(`no fixture ${filename}`);
  return Promise.resolve(bytes);
}

function doc(commands: WastJson["commands"]): WastJson {
  return { source_filename: "fixture.wast", commands };
}

function assertEq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

Deno.test("environment: V8 validates core modules but no component binaries", () => {
  assertEq(WebAssembly.validate(EMPTY_CORE_MODULE), true, "core valid");
  assertEq(WebAssembly.validate(BAD_VERSION_MODULE), false, "bad version");
  // The load-bearing fact behind skip("pending-runtime"): the JS API rejects
  // the component layer preamble outright, so `validate === false` carries
  // no information about a component's actual validity.
  assertEq(WebAssembly.validate(EMPTY_COMPONENT), false, "component rejected");
});

Deno.test("core module command executes via the JS WebAssembly API", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "ok.0.wasm",
        module_type: "binary",
        kind: "module",
      },
      {
        type: "assert_invalid",
        line: 2,
        filename: "bad.0.wasm",
        module_type: "binary",
        kind: "module",
        text: "whatever",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => r.status),
    ["passed", "passed"],
    "statuses",
  );
});

Deno.test("core invoke and definition instantiation are pending-runtime", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "ok.0.wasm",
        module_type: "binary",
        kind: "module",
      },
      {
        type: "assert_return",
        line: 2,
        action: { type: "invoke", field: "f", args: [] },
        expected: [],
      },
      { type: "module_instance", line: 3, instance: "i", module: "M" },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => [r.status, r.reason ?? null]),
    [["passed", null], ["skipped", "pending-runtime"], [
      "skipped",
      "pending-runtime",
    ]],
    "statuses",
  );
});

Deno.test("component-layer commands are pending-runtime", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "comp.0.wasm",
        module_type: "binary",
        kind: "component",
      },
      {
        type: "assert_invalid",
        line: 2,
        filename: "comp.0.wasm",
        module_type: "binary",
        kind: "component",
        text: "whatever",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => [r.status, r.reason ?? null]),
    [["skipped", "pending-runtime"], ["skipped", "pending-runtime"]],
    "statuses",
  );
});

Deno.test("text artifacts are unsupported-directive", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "assert_malformed",
        line: 1,
        filename: "x.0.wat",
        module_type: "text",
        kind: "component",
        text: "whatever",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(
    result.results.map((r) => [r.status, r.reason ?? null]),
    [["skipped", "unsupported-directive"]],
    "statuses",
  );
});

Deno.test("a genuinely invalid core module fails assert-free module command", async () => {
  const result = await runWastJson(
    doc([
      {
        type: "module",
        line: 1,
        filename: "bad.0.wasm",
        module_type: "binary",
        kind: "module",
      },
    ]),
    load,
    new CoreOnlyExecutor(),
  );
  assertEq(result.results[0].status, "failed", "status");
});
