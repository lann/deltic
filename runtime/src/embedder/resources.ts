// Resources as classes on both sides of the boundary
// (contracts/embedder-api.md §"Resources"; C2 checklist item 3).
//
// The raw boundary represents `own<R>` / `borrow<R>` as bare **reps**
// (cabi/handles.ts `liftOwn` returns `rh.rep`; the host never holds a table
// index). C0 findings 1-3 were embedders turning that into identity tables and
// hand-transcribed `[method]…` keys by hand. Both become runtime obligations
// here.
//
// Ownership, per the contract's 2x4 table:
//
// | position                | guest-implemented R          | host-implemented R        |
// | host receives own<R>    | new wrapper (host owns)      | instance back, mapping released, NO dispose |
// | host receives borrow<R> | wrapper valid for the call   | instance, mapping kept    |
// | host passes own<R>      | wrapper invalidated          | instance registered       |
// | host passes borrow<R>   | wrapper stays valid          | rep reused/allocated      |

import type { ResourceTypeInfo, ValType } from "../cabi/types.ts";
import { InvalidHandleError } from "./errors.ts";
import { camelCase, pascalCase } from "./casing.ts";

/** Internal state of a guest-resource wrapper. Keyed off a module symbol. */
const STATE = Symbol("deltic.resource-state");

interface WrapperState {
  rep: number;
  /** False once the handle was transferred away or dropped. */
  valid: boolean;
  /** True for `own` wrappers, which are responsible for dropping. */
  owns: boolean;
  rt: ResourceTypeInfo;
  className: string;
}

/** Base of every runtime-built guest-resource class. */
export class GuestResource {
  /** @internal */
  declare [STATE]: WrapperState;

  /** Drop the handle (alias of `[Symbol.dispose]`, so TS `using` works). */
  drop(): void {
    dropWrapper(this);
  }

  [Symbol.dispose](): void {
    dropWrapper(this);
  }
}

/**
 * Backstop for leaked handles (PLAN §7). A wrapper that becomes unreachable
 * without `drop()` still runs the guest destructor — late, but not never.
 */
const leaked = new FinalizationRegistry<WrapperState>((s) => {
  if (s.valid && s.owns) {
    s.valid = false;
    try {
      s.rt.dtor?.(s.rep);
    } catch {
      // A destructor that traps during GC has nowhere to report to.
    }
  }
});

export function initWrapper(
  w: GuestResource,
  state: WrapperState,
): void {
  (w as unknown as Record<symbol, WrapperState>)[STATE] = state;
  if (state.owns) leaked.register(w, state, w);
}

export function wrapperState(w: object): WrapperState | undefined {
  return (w as unknown as Record<symbol, WrapperState | undefined>)[STATE];
}

function requireLive(w: object, what: string): WrapperState {
  const s = wrapperState(w);
  if (s === undefined) {
    throw new InvalidHandleError(`${what}: not a resource handle`);
  }
  if (!s.valid) {
    throw new InvalidHandleError(
      `${what}: this ${s.className} handle is no longer valid (it was ` +
        `transferred as own<…>, dropped, or was a borrow that outlived its ` +
        `call)`,
    );
  }
  return s;
}

function dropWrapper(w: GuestResource): void {
  const s = wrapperState(w);
  if (s === undefined || !s.valid) return;
  s.valid = false;
  leaked.unregister(w);
  if (!s.owns) return; // a borrow was never ours to drop
  // Host-initiated drop of a guest handle. The host holds a rep, never a
  // table index, so there is nothing to remove from a handle table: the
  // observable half of definitions.py `canon_resource_drop` (line 2325) for an
  // owning handle is exactly `rt.dtor(rep)`.
  s.rt.dtor?.(s.rep);
}

/** Invalidate a wrapper without dropping (used to end a borrow's lifetime). */
export function invalidateWrapper(w: object): void {
  const s = wrapperState(w);
  if (s === undefined) return;
  s.valid = false;
  leaked.unregister(w as GuestResource);
}

/** Read a wrapper's rep for a lowering site, applying the ownership rule. */
export function takeRep(w: unknown, own: boolean, what: string): number {
  if (typeof w !== "object" || w === null) {
    throw new InvalidHandleError(
      `${what}: expected a resource class instance, got ${typeof w}`,
    );
  }
  const s = requireLive(w, what);
  if (own) {
    // Transfer: the wrapper is invalidated, and must NOT run the destructor.
    s.valid = false;
    leaked.unregister(w as GuestResource);
  }
  return s.rep;
}

/** Everything needed to build one guest-resource class. */
export interface GuestResourceSpec {
  /** WIT resource name (kebab). */
  name: string;
  /** The raw `[constructor]r` lifted function, if the resource has one. */
  ctor: ((...a: unknown[]) => unknown) | null;
  ctorParams: ValType[] | null;
  methods: {
    member: string;
    raw: (...a: unknown[]) => unknown;
    params: ValType[];
    results: ValType[];
  }[];
  statics: {
    member: string;
    raw: (...a: unknown[]) => unknown;
    params: ValType[];
    results: ValType[];
  }[];
}

export type CallAdapter = (
  raw: (...a: unknown[]) => unknown,
  params: ValType[],
  results: ValType[],
  where: string,
  args: unknown[],
) => Promise<unknown>;

/**
 * Build the class for a guest-implemented resource.
 *
 * The JS constructor is **synchronous**: a JS constructor cannot return a
 * Promise, so the contract's "exports are uniformly Promise-shaped" rule has
 * one unavoidable exception here. A guest constructor that does not complete
 * synchronously is reported as such rather than silently returning a
 * half-built object (see the report's contract-friction list).
 */
export function buildGuestResourceClass(
  spec: GuestResourceSpec,
  rt: ResourceTypeInfo,
  adapt: CallAdapter,
  lowerArgs: (args: unknown[], params: ValType[], where: string) => unknown[],
  // deno-lint-ignore no-explicit-any
): any {
  const className = pascalCase(spec.name);
  const cls = class extends GuestResource {
    constructor(...args: unknown[]) {
      super();
      if (spec.ctor === null) {
        throw new TypeError(
          `${className} has no WIT constructor; use its static functions`,
        );
      }
      const where = `${className} constructor`;
      const lowered = lowerArgs(args, spec.ctorParams ?? [], where);
      const rep = spec.ctor(...lowered);
      if (rep !== null && typeof rep === "object" && "then" in rep) {
        throw new TypeError(
          `${where}: the guest constructor did not complete synchronously. ` +
            `A JS constructor cannot await; expose an async factory instead.`,
        );
      }
      if (typeof rep !== "number") {
        throw new TypeError(
          `${where}: expected an own handle rep, got ${typeof rep}`,
        );
      }
      initWrapper(this, {
        rep,
        valid: true,
        owns: true,
        rt,
        className,
      });
    }
  };
  Object.defineProperty(cls, "name", { value: className });

  for (const m of spec.methods) {
    const js = camelCase(m.member);
    const where = `${className}.${js}`;
    Object.defineProperty(cls.prototype, js, {
      configurable: true,
      writable: true,
      value: function (this: GuestResource, ...args: unknown[]) {
        // params[0] is the `borrow<R>`/`own<R>` self.
        return adapt(m.raw, m.params, m.results, where, [this, ...args]);
      },
    });
  }
  for (const s of spec.statics) {
    const js = camelCase(s.member);
    const where = `${className}.${js} (static)`;
    Object.defineProperty(cls, js, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) =>
        adapt(s.raw, s.params, s.results, where, args),
    });
  }
  return cls;
}

/** Materialize an `own`/`borrow` wrapper for a rep coming out of a guest. */
export function makeWrapper(
  // deno-lint-ignore no-explicit-any
  cls: any,
  rep: number,
  rt: ResourceTypeInfo,
  owns: boolean,
): GuestResource {
  const w = Object.create(cls.prototype) as GuestResource;
  initWrapper(w, {
    rep,
    valid: true,
    owns,
    rt,
    className: cls.name ?? "resource",
  });
  return w;
}

// ---------------------------------------------------------------------------
// Host-implemented resources
// ---------------------------------------------------------------------------

/**
 * Runtime-owned instance <-> rep mapping for a host-implemented resource.
 *
 * The rep->instance direction is a **strong** map for exactly as long as the
 * guest holds handles: the guest's handle is the only reference keeping a
 * host object alive across calls, and a weak map here would let it be
 * collected under the guest's feet.
 */
export class HostResourceRegistry {
  readonly #byRep = new Map<number, object>();
  readonly #byInstance = new WeakMap<object, number>();
  #next = 1;

  constructor(readonly className: string) {}

  /** The host is passing an instance to the guest: allocate (or reuse) a rep. */
  repFor(instance: unknown): number {
    if (instance === null || typeof instance !== "object") {
      throw new TypeError(
        `${this.className}: expected a class instance, got ${typeof instance}`,
      );
    }
    const held = this.#byInstance.get(instance);
    if (held !== undefined && this.#byRep.has(held)) return held;
    const rep = this.#next++;
    this.#byRep.set(rep, instance);
    this.#byInstance.set(instance, rep);
    return rep;
  }

  /** Is this instance already registered with a live rep? */
  hasInstance(instance: unknown): boolean {
    if (instance === null || typeof instance !== "object") return false;
    const held = this.#byInstance.get(instance);
    return held !== undefined && this.#byRep.has(held);
  }

  /** Is `rep` live? Diagnostics and white-box tests. */
  hasRep(rep: number): boolean {
    return this.#byRep.has(rep);
  }

  /** Release a rep if it is still live; no dtor, no error when already gone. */
  releaseIfPresent(rep: number): void {
    this.#byRep.delete(rep);
  }

  /** A `borrow<R>` arrived from the guest: the host's own instance, mapping kept. */
  lookup(rep: number): object {
    const inst = this.#byRep.get(rep);
    if (inst === undefined) {
      throw new InvalidHandleError(
        `${this.className}: no live instance for rep ${rep}`,
      );
    }
    return inst;
  }

  /**
   * An `own<R>` arrived from the guest: the host gets its instance back, the
   * guest's handle is gone, and **no dispose runs** (the contract's 2x4 table).
   */
  release(rep: number): object {
    const inst = this.lookup(rep);
    this.#byRep.delete(rep);
    return inst;
  }

  /**
   * The guest dropped its last own handle: run the destructor. This is the
   * `HostResourceType` dtor the executor calls from `canon_resource_drop`.
   */
  dtor(rep: number): void {
    const inst = this.#byRep.get(rep);
    if (inst === undefined) return;
    this.#byRep.delete(rep);
    (inst as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  }

  /** Live handle count — diagnostics and tests. */
  get liveCount(): number {
    return this.#byRep.size;
  }
}
