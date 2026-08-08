// Ports of run_tests.py `test_flatten` plus fixture-driven checks of
// alignment/elem_size/flatten_type against instrumented definitions.py runs
// (see tests/fixtures/generate.py).

import sizesFixture from "./fixtures/sizes_flatten.json" with {
  type: "json",
};
import functypeFixture from "./fixtures/functype_flatten.json" with {
  type: "json",
};
import {
  alignment,
  type CoreType,
  elemSize,
  flattenFunctype,
  flattenType,
  type FuncType,
  MemInst,
  mkCanonicalOptions,
  type PtrType,
} from "../src/cabi/mod.ts";
import { parseType, type TypeDsl } from "./support/typedsl.ts";
import { assertEq } from "./support/asserts.ts";
import { mkOpts } from "./support/driver.ts";

const PTR_TYPES: PtrType[] = ["i32", "i64"];

Deno.test("alignment and elem_size match definitions.py (fixtures)", () => {
  for (const entry of sizesFixture.entries) {
    const t = parseType(entry.type as TypeDsl);
    for (const at of PTR_TYPES) {
      assertEq(
        alignment(t, at),
        entry.align[at],
        `alignment(${JSON.stringify(entry.type)}, ${at})`,
      );
      assertEq(
        elemSize(t, at),
        entry.size[at],
        `elem_size(${JSON.stringify(entry.type)}, ${at})`,
      );
    }
  }
});

Deno.test("flatten_type matches definitions.py (fixtures)", () => {
  for (const entry of sizesFixture.entries) {
    const t = parseType(entry.type as TypeDsl);
    for (const at of PTR_TYPES) {
      const opts = mkOpts(new MemInst(new Uint8Array(0), at));
      assertEq(
        flattenType(t, opts),
        entry.flat[at] as CoreType[],
        `flatten_type(${JSON.stringify(entry.type)}, ${at})`,
      );
    }
  }
});

Deno.test("flatten_functype matches definitions.py (fixtures)", () => {
  for (const entry of functypeFixture.entries) {
    const ft: FuncType = {
      params: (entry.params as TypeDsl[]).map(parseType),
      results: (entry.results as TypeDsl[]).map(parseType),
      async: entry.async,
    };
    const opts = mkCanonicalOptions({
      memory: new MemInst(new Uint8Array(0), entry.addrType as PtrType),
      async_: entry.async,
      callback: entry.callback ? () => {} : null,
    });
    for (const context of ["lift", "lower"] as const) {
      const got = flattenFunctype(opts, ft, context);
      assertEq(
        { params: got.params, results: got.results },
        entry[context],
        `flatten_functype(${entry.name}, ${context})`,
      );
    }
  }
});
