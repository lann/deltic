// The value table, end to end: the `values` fixture's 17 echo exports driven
// through the conventions facade (contracts/embedder-api.md §"Value mapping").
//
// Every assertion here is a statement about the *contract's* shapes, not the
// interpreter's: single-key variants, `{some}`/`{none}`, tuple-as-record and
// kebab record keys all live on the far side of the adapter and must never
// appear.

import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import { WitError } from "../../src/embedder/mod.ts";

const ready = await haveFixture(guest("values"));

// deno-lint-ignore no-explicit-any
let v: any;
if (ready) v = (await instantiateFixture(guest("values"))).exports;

Deno.test({
  name: "values: exports are camelCase and uniformly Promise-shaped",
  ignore: !ready,
  fn: async () => {
    const names = Object.keys(v).sort();
    assertEq(names.includes("echoBool"), true, `exports: ${names}`);
    assertEq(names.includes("echoListU8"), true, `exports: ${names}`);
    assertEq(names.includes("echo-bool"), false, "no kebab spellings survive");
    // Even a sync WIT function returns a Promise: one calling convention.
    const p = v.echoBool(true);
    assertEq(p instanceof Promise, true, "exports are uniformly Promise-shaped");
    assertEq(await p, true);
  },
});

Deno.test({
  name: "values: primitives, bigints, char and string",
  ignore: !ready,
  fn: async () => {
    assertEq(await v.echoBool(false), false);
    assertEq(await v.echoU64(18446744073709551615n), 18446744073709551615n);
    assertEq(await v.echoS64(-9223372036854775808n), -9223372036854775808n);
    assertEq(await v.echoF32(0.5), 0.5);
    assertEq(await v.echoF64(-1.25), -1.25);
    assertEq(await v.echoChar("é"), "é");
    assertEq(await v.echoString("héllo"), "héllo");
  },
});

Deno.test({
  name: "values: u64/s64 want bigints and ranges are checked at lower",
  ignore: !ready,
  fn: async () => {
    assertEq(
      String(await caught(() => v.echoU64(5))).includes("expects a bigint"),
      true,
    );
    assertEq(
      String(await caught(() => v.echoU64(-1n))).includes("out of range"),
      true,
    );
    assertEq(
      String(await caught(() => v.echoChar("ab"))).includes("single-code-point"),
      true,
    );
  },
});

Deno.test({
  name: "values: records carry camelCase fields, not kebab labels",
  ignore: !ready,
  fn: async () => {
    // `mixed { a: u32, b: string, c: f64, d: bool }` — single-fragment labels,
    // so casing is identity here; what matters is the *shape*: a plain object,
    // never the interpreter's despecialized record.
    const r = { a: 7, b: "hi", c: 2.5, d: true };
    assertEq(await v.echoRecord(r), r);
  },
});

Deno.test({
  name: "values: variants are { tag, val? }, payloadless cases omit val",
  ignore: !ready,
  fn: async () => {
    // `variant shape { point, circle(f64), label(string), rect(size) }`.
    const point = await v.echoVariant({ tag: "point" });
    assertEq(point, { tag: "point" });
    assertEq("val" in point, false, "`val` is ABSENT, not undefined");
    assertEq(await v.echoVariant({ tag: "circle", val: 1.5 }), {
      tag: "circle",
      val: 1.5,
    });
    assertEq(await v.echoVariant({ tag: "label", val: "x" }), {
      tag: "label",
      val: "x",
    });
    assertEq(await v.echoVariant({ tag: "rect", val: { w: 3, h: 4 } }), {
      tag: "rect",
      val: { w: 3, h: 4 },
    });
    // Case names are DATA: kebab-case verbatim, never camelCased.
    assertEq(
      String(await caught(() => v.echoVariant({ tag: "nope" }))).includes(
        "unknown variant case",
      ),
      true,
    );
  },
});

Deno.test({
  name: "values: enums are plain strings, unchanged",
  ignore: !ready,
  fn: async () => {
    assertEq(await v.echoEnum("red"), "red");
    assertEq(await v.echoEnum("blue"), "blue");
    assertEq(
      String(await caught(() => v.echoEnum("purple"))).includes("enum expects"),
      true,
    );
  },
});

Deno.test({
  name: "values: flags are objects of camelCase booleans; absent = false",
  ignore: !ready,
  fn: async () => {
    // `flags perms { read, write, exec, admin }`.
    assertEq(await v.echoFlags({ read: true, exec: true }), {
      read: true,
      write: false,
      exec: true,
      admin: false,
    }, "lift presents EVERY flag; lower reads an omitted flag as false");
  },
});

Deno.test({
  name: "values: the outermost option is T | undefined",
  ignore: !ready,
  fn: async () => {
    assertEq(await v.echoOption("x"), "x");
    assertEq(await v.echoOption(undefined), undefined);
  },
});

Deno.test({
  name: "values: an option nested directly inside an option boxes",
  ignore: !ready,
  fn: async () => {
    // contracts/embedder-api.md §"Option rule", the Some(None) edge:
    //   undefined                 -> none
    //   { tag: "none" }           -> some(none)
    //   { tag: "some", val: 7 }   -> some(some(7))
    assertEq(await v.echoOptionNested(undefined), undefined);
    const someNone = await v.echoOptionNested({ tag: "none" });
    assertEq(someNone, { tag: "none" });
    assertEq("val" in someNone, false);
    assertEq(await v.echoOptionNested({ tag: "some", val: 7 }), {
      tag: "some",
      val: 7,
    });
  },
});

Deno.test({
  name: "values: result in FUNCTION-RESULT position resolves T / rejects WitError",
  ignore: !ready,
  fn: async () => {
    // `echo-result: func(v: result<u32, string>) -> result<u32, string>`: the
    // parameter is a result nested as a VALUE ({tag,val} data, never throws),
    // the return is a result in function-result position (T or WitError).
    assertEq(await v.echoResult({ tag: "ok", val: 42 }), 42);

    const e = await caught(() => v.echoResult({ tag: "err", val: "boom" }));
    assertEq(e instanceof WitError, true, `expected WitError, got ${e}`);
    assertEq((e as WitError).payload, "boom");
    assertEq((e as WitError).name, "WitError");
  },
});

Deno.test({
  name: "values: list<u8> is a Uint8Array; other lists are plain arrays",
  ignore: !ready,
  fn: async () => {
    const bytes = await v.echoListU8(new Uint8Array([1, 2, 3]));
    assertEq(bytes instanceof Uint8Array, true, "list<u8> lifts as Uint8Array");
    assertEq(bytes, new Uint8Array([1, 2, 3]));
    const strs = await v.echoListString(["a", "b"]);
    assertEq(Array.isArray(strs), true, "list<string> is a plain array");
    assertEq(strs, ["a", "b"]);
  },
});

Deno.test({
  name: "values: tuples are real arrays, not despecialized records",
  ignore: !ready,
  fn: async () => {
    const t = await v.echoTuple([1, "two", 3.5]);
    assertEq(Array.isArray(t), true, "tuple<...> is a real TS tuple");
    assertEq(t, [1, "two", 3.5]);
    assertEq(
      String(await caught(() => v.echoTuple({ 0: 1, 1: "two", 2: 3.5 })))
        .includes("tuple expects an array"),
      true,
      "the interpreter's tuple-as-record shape is not accepted",
    );
  },
});

Deno.test({
  name: "values: arity mismatches are named, not silently coerced",
  ignore: !ready,
  fn: async () => {
    assertEq(
      String(await caught(() => v.echoBool())).includes("expected 1 argument"),
      true,
    );
  },
});

Deno.test({
  name: "values: a result case with a payload must be GIVEN one",
  ignore: !ready,
  fn: async () => {
    // Symmetric with the variant path: silently lowering `null` for a missing
    // `val` would put a zero where the guest expects data.
    assertEq(
      String(await caught(() => v.echoResult({ tag: "ok" })))
        .includes("needs a 'val'"),
      true,
    );
    assertEq(
      String(await caught(() => v.echoResult({ tag: "err" })))
        .includes("needs a 'val'"),
      true,
    );
  },
});

Deno.test({
  name: "values: char rejects a lone surrogate at the adapter, naming the site",
  ignore: !ready,
  fn: async () => {
    // `"\ud800"` has one code point but is not a Unicode scalar value, so it
    // cannot be a `char`. The adapter reports it with the site name rather
    // than letting the interpreter raise its own, less specific message.
    const e = await caught(() => v.echoChar("\ud800"));
    assertEq(String(e).includes("lone surrogate"), true, `${e}`);
    assertEq(String(e).includes("U+D800"), true, `${e}`);
    assertEq(String(e).includes("echo-char"), true, `it names the site: ${e}`);
    // A well-formed astral character is fine.
    assertEq(await v.echoChar("𝄞"), "𝄞");
  },
});
