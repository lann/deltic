// Minimal assertions, local on purpose: `@polyengine/protocol` is dependency-free
// by contract (contracts/embedder-api.md §"Module identity"), and that is
// worth keeping true of its test graph too — a jsr dependency here would show
// up in the workspace lockfile for a package whose whole point is that it
// carries nothing.

export function assert(cond: boolean, msg = ""): void {
  if (!cond) throw new Error(`assertion failed${msg === "" ? "" : `: ${msg}`}`);
}

export function assertFalse(cond: boolean, msg = ""): void {
  assert(!cond, msg);
}

export function assertEquals(got: unknown, want: unknown, msg = ""): void {
  const g = JSON.stringify(got) ?? String(got);
  const w = JSON.stringify(want) ?? String(want);
  if (g !== w) {
    throw new Error(`${msg === "" ? "mismatch" : msg}: got ${g}, want ${w}`);
  }
}

export function assertThrows(
  fn: () => unknown,
  // deno-lint-ignore no-explicit-any
  ctor?: new (...a: any[]) => Error,
  includes?: string,
): Error {
  let thrown: unknown;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    thrown = e;
  }
  assert(threw, "expected a throw");
  if (ctor !== undefined) {
    assert(thrown instanceof ctor, `expected ${ctor.name}, got ${thrown}`);
  }
  if (includes !== undefined) {
    const m = String((thrown as Error).message);
    assert(m.includes(includes), `message should include ${includes}: ${m}`);
  }
  return thrown as Error;
}
