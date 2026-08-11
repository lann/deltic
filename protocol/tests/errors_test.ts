// Recognition is by brand, not class (contracts/embedder-api.md §"Error
// model", amendment A8; issue #83).
//
// Two properties are under test, and they are the two halves of the amendment:
// a value minted by ANY copy is recognized (simulated here by hand-rolling
// the brand, which is exactly what a foreign copy's prototype provides), and
// an unbranded look-alike is NOT.

import { assert, assertEquals, assertFalse } from "./assert.ts";
import {
  DroppedError,
  InvalidHandleError,
  isDroppedError,
  isInvalidHandleError,
  isPeerTrappedError,
  isStreamProducerError,
  isTrap,
  isWitError,
  PeerTrappedError,
  StreamProducerError,
  Trap,
  WitError,
} from "../src/mod.ts";

Deno.test("A8: canonical classes are recognized by their own predicate", () => {
  assert(isWitError(new WitError({ tag: "nope" })));
  assert(isTrap(new Trap("x")));
  assert(isDroppedError(new DroppedError()));
  assert(isPeerTrappedError(new PeerTrappedError("where", new Error("e"))));
  assert(isInvalidHandleError(new InvalidHandleError("x")));
  assert(isStreamProducerError(new StreamProducerError("w", new Error("e"))));
});

Deno.test("A8: the brands do not cross-talk", () => {
  assertFalse(isTrap(new WitError(1)));
  assertFalse(isWitError(new Trap()));
  assertFalse(isDroppedError(new PeerTrappedError("w", "c")));
  assertFalse(isPeerTrappedError(new DroppedError()));
});

Deno.test("A8: a hand-rolled brand IS the value (zero-import host module)", () => {
  // Precisely the shape contracts/embedder-api.md blesses: "an Error with
  // [Symbol.for('deltic.witError/1')]: true and a payload property IS a
  // WitError to every copy".
  const e = Object.assign(new Error("boom"), {
    [Symbol.for("deltic.witError/1")]: true,
    payload: { tag: "denied" },
  });
  assert(isWitError(e));
  assertEquals(e.payload, { tag: "denied" });

  // Not even an Error: brands are markers, not a class hierarchy.
  assert(isTrap({ [Symbol.for("deltic.trap/1")]: true }));
  assert(isStreamProducerError(
    { [Symbol.for("deltic.streamProducer/1")]: true },
  ));
});

Deno.test("A8: unbranded look-alikes are refused", () => {
  class NotAWitError extends Error {
    payload = 1;
  }
  assertFalse(isWitError(new NotAWitError()));
  assertFalse(isWitError(new Error("plain")));
  assertFalse(isWitError({ payload: 1 }));
  assertFalse(isWitError(null));
  assertFalse(isWitError(undefined));
  assertFalse(isWitError("deltic.witError/1"));
  assertFalse(isWitError(42));
  // Present but not exactly `true`: refused (no truthiness coercion).
  assertFalse(isWitError({ [Symbol.for("deltic.witError/1")]: 1 }));
});

Deno.test("A8: predicates are NOT instanceof — a foreign prototype passes", () => {
  // A different copy's class: same brand key (registry symbol), different
  // constructor identity. This is the #83 failure mode, made to pass.
  class ForeignWitError extends Error {
    payload: unknown;
    constructor(payload: unknown) {
      super("foreign");
      this.payload = payload;
    }
  }
  Object.defineProperty(
    ForeignWitError.prototype,
    Symbol.for("deltic.witError/1"),
    { value: true },
  );
  const e = new ForeignWitError({ tag: "x" });
  assertFalse(e instanceof WitError, "premise: class identity differs");
  assert(isWitError(e), "brand identity holds");
});

Deno.test("A8: Symbol.hasInstance is deliberately NOT overridden", () => {
  // Overriding it would be inherited by consumer subclasses, so
  // `x instanceof MySubclass` would match ANY branded value — a worse footgun
  // than the one A8 removes. instanceof keeps its plain nominal meaning.
  class Sub extends WitError<number> {}
  assertFalse(new WitError(1) instanceof Sub);
  assert(new Sub(1) instanceof WitError);
});
