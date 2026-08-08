// Trap and assertion machinery (definitions.py `Trap`, `trap`, `trap_if`).
//
// `Trap` models a Component Model trap — a deterministic guest-visible fault.
// `AssertionError` models the reference's Python `assert`s: internal
// invariants that callers are supposed to make unviolable. Tests treat only
// `Trap` as an expected outcome.

export class Trap extends Error {
  constructor(message = "canonical ABI trap") {
    super(message);
    this.name = "Trap";
  }
}

export function trap(message?: string): never {
  throw new Trap(message);
}

export function trapIf(cond: boolean, message?: string): void {
  if (cond) trap(message);
}

export class AssertionError extends Error {
  constructor(message = "internal assertion failed") {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert_(cond: boolean, message?: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

/** Marks a definitions.py code path this v1 interpreter does not port yet. */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`not implemented in cabi v1: ${what}`);
    this.name = "NotImplemented";
  }
}
