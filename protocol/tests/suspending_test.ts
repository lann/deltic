// The suspendability marker, moved here by amendment A8 (contracts/embedder-api.md
// §"Functions and async", amendments A1/A2).
//
// End-to-end park semantics stay pinned where the wasm lives
// (runtime/tests/embedder/suspending_imports_test.ts, which imports through
// the unchanged `@deltic/runtime/embedder` re-export). What is pinned HERE is
// the vocabulary half A8 owns: the mark is a process-global brand, so it is
// readable by any copy and hand-rollable, and the decorator's loud refusals
// survived the move.

import { assert, assertEquals, assertFalse, assertThrows } from "./assert.ts";
import { anySuspendingImport, isSuspending, suspending } from "../src/mod.ts";

Deno.test("A1: suspending() marks in place and the brand reads back", () => {
  const fn = (a: number) => a;
  const marked = suspending(fn);
  assert(marked === fn, "the value is marked in place");
  assert(isSuspending(marked));
  assertFalse(isSuspending((a: number) => a));
  assertFalse(isSuspending({}));
  assertFalse(isSuspending(undefined));
});

Deno.test("A8: the mark is the process-global brand, not a module-local symbol", () => {
  const fn = suspending(() => 1);
  assertEquals(
    (fn as unknown as Record<symbol, unknown>)[
      Symbol.for("deltic.suspending/1")
    ],
    true,
  );
  // Hand-rolled: a zero-import host module can declare suspendability with
  // nothing but the registry symbol (brands are markers, not gatekeepers).
  const hand = Object.defineProperty(() => 1, Symbol.for("deltic.suspending/1"), {
    value: true,
  });
  assert(isSuspending(hand));
});

Deno.test("A8: the mark is non-enumerable (invisible to imports-record walks)", () => {
  const fn = suspending(() => 1);
  assertEquals(Object.getOwnPropertySymbols(fn).length, 1);
  assertEquals(Object.propertyIsEnumerable.call(fn, Symbol.for("deltic.suspending/1")), false);
  // Re-marking is a no-op, not a TypeError on a non-configurable property.
  suspending(fn);
  assert(isSuspending(fn));
});

Deno.test("A1: anySuspendingImport walks top level and one interface level", () => {
  assertFalse(anySuspendingImport(undefined));
  assertFalse(anySuspendingImport({}));
  assertFalse(anySuspendingImport({ f: () => 1, i: { g: () => 1 } }));
  assert(anySuspendingImport({ f: suspending(() => 1) }));
  assert(anySuspendingImport({ i: { g: suspending(() => 1) } }));
  assert(anySuspendingImport({ i: null, j: { g: suspending(() => 1) } }));
});

Deno.test("A2: @suspending marks instance and static methods", () => {
  class Provider {
    @suspending
    read(): number {
      return 1;
    }

    @suspending
    static probe(): number {
      return 2;
    }
  }
  // The brand authority for instance methods is the CLASS PROTOTYPE.
  assert(isSuspending(Provider.prototype.read));
  assert(isSuspending(Provider.probe));
});

Deno.test("A2: the decorator refuses non-method positions at class-definition time", () => {
  // A silent no-op would surface as a runtime `NeedsJspi` far from the mistake.
  for (const kind of ["getter", "setter", "field", "class", "accessor"]) {
    assertThrows(
      () => suspending((() => 1) as CallableFunction, { kind }),
      TypeError,
      `cannot decorate a ${kind}`,
    );
  }
});

Deno.test("A2: the legacy experimentalDecorators convention is refused with guidance", () => {
  // Under that convention the decorator receives the PROTOTYPE, not the
  // method: marking it would brand the wrong object AND corrupt the descriptor.
  const e = assertThrows(
    () => suspending((() => 1) as CallableFunction, "read", { value: () => 1 }),
    TypeError,
  );
  assert(e.message.includes("experimentalDecorators"));
  assert(e.message.includes("suspending(fn)"));
});

Deno.test("suspending(): a non-function is refused", () => {
  assertThrows(
    () => suspending({} as unknown as CallableFunction),
    TypeError,
    "expected a function",
  );
});
