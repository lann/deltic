// Plan loader unit tests: formatVersion gating, envelope handling, and the
// wire -> in-memory descriptor-IR conversions (including the deliberate
// deltas recorded in src/plan/loader.ts).

import { assertEq } from "./support/asserts.ts";
import {
  loadEnvelope,
  loadPlan,
  loadValType,
  PlanError,
} from "../src/plan/mod.ts";
import type { WirePlan, WireValType } from "../src/plan/mod.ts";
import { ResourceTypeInfo } from "../src/cabi/mod.ts";

function assertPlanError(fn: () => unknown, includes: string) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    assertEq(String(e).includes(includes), true, `message: ${e}`);
    return;
  }
  throw new Error(`expected PlanError containing '${includes}'`);
}

function minimalPlan(overrides: Partial<WirePlan> = {}): WirePlan {
  return {
    formatVersion: 0,
    producer: { shimVersion: "0", wasmtimeEnviron: "47.0.3", features: [] },
    component: { sha256: "0".repeat(64), len: 0 },
    modules: [],
    initializers: [],
    trampolines: [],
    canonicalOptions: [],
    types: [],
    resourceTables: [],
    imports: [],
    exports: [],
    worldDigest: "sha256:0",
    ...overrides,
  };
}

Deno.test("loader: formatVersion is validated and fails fast", () => {
  loadPlan(minimalPlan()); // v0 loads
  assertPlanError(
    () => loadPlan(minimalPlan({ formatVersion: 1 })),
    "formatVersion 1",
  );
});

Deno.test("loader: envelope error and shape handling", () => {
  assertPlanError(() => loadEnvelope("not json"), "not valid JSON");
  assertPlanError(
    () => loadEnvelope(`{"error":"boom"}`),
    "translator error: boom",
  );
  assertPlanError(() => loadEnvelope(`{}`), "missing `plan`");
  const { wire, adapters } = loadEnvelope(JSON.stringify({
    plan: minimalPlan(),
    adapters: [{ file: "adapters/1.wasm", wasm: btoa("\x00asm") }],
  }));
  assertEq(wire.formatVersion, 0);
  assertEq(adapters.get("adapters/1.wasm"), new Uint8Array([0, 97, 115, 109]));
});

Deno.test("loader: func type conversion drops labels, keeps order", () => {
  const loaded = loadPlan(minimalPlan({
    types: [{
      kind: "func",
      params: [
        { label: "a", type: { kind: "u32" } },
        { label: "b", type: { kind: "string" } },
      ],
      results: [{ kind: "bool" }],
      async: false,
    }],
  }));
  const entry = loaded.types[0];
  assertEq(entry.kind, "func");
  if (entry.kind !== "func") throw new Error("unreachable");
  assertEq(entry.paramNames, ["a", "b"]);
  assertEq(entry.funcType.params, [{ kind: "u32" }, { kind: "string" }]);
  assertEq(entry.funcType.results, [{ kind: "bool" }]);
  assertEq(entry.funcType.async, false);
});

Deno.test("loader: result `err` (wire) becomes `error` (in-memory)", () => {
  const t = loadValType(
    { kind: "result", ok: { kind: "u32" }, err: { kind: "string" } },
    [],
    "test",
  );
  assertEq(t, {
    kind: "result",
    ok: { kind: "u32" },
    error: { kind: "string" },
  });
});

Deno.test("loader: own/borrow resolve resource-table tokens by identity", () => {
  const loaded = loadPlan(minimalPlan({
    resourceTables: [{ kind: "concrete", resource: 0, instance: 0 }],
    types: [
      { kind: "own", resource: 0 },
      { kind: "borrow", resource: 0 },
    ],
  }));
  const own = loaded.types[0];
  const borrow = loaded.types[1];
  if (own.kind !== "value" || borrow.kind !== "value") {
    throw new Error("expected value entries");
  }
  const ownRt = (own.type as { rt: ResourceTypeInfo }).rt;
  const borrowRt = (borrow.type as { rt: ResourceTypeInfo }).rt;
  assertEq(ownRt instanceof ResourceTypeInfo, true);
  assertEq(ownRt === borrowRt, true, "same table -> same identity token");
  assertEq(ownRt === loaded.resourceTokens[0], true);

  // Out-of-range table reference is a load-time error.
  assertPlanError(
    () =>
      loadPlan(minimalPlan({
        types: [{ kind: "own", resource: 3 } as WireValType],
      })),
    "resource table 3",
  );
});

Deno.test("loader: nested structural types convert recursively", () => {
  const wire: WireValType = {
    kind: "variant",
    cases: [
      { label: "none", type: null },
      {
        label: "some",
        type: {
          kind: "list",
          element: {
            kind: "record",
            fields: [{ label: "x", type: { kind: "option", type: { kind: "f64" } } }],
          },
        },
      },
    ],
  };
  const t = loadValType(wire, [], "test");
  assertEq(t, {
    kind: "variant",
    cases: [
      { label: "none", type: null },
      {
        label: "some",
        type: {
          kind: "list",
          element: {
            kind: "record",
            fields: [
              { label: "x", type: { kind: "option", type: { kind: "f64" } } },
            ],
          },
        },
      },
    ],
  });
});
