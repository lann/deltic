// The conventions facade: `instantiate(artifacts, imports, opts)`.
//
// DESIGN (orchestrator ruling, C2): the facade is **runtime-driven**. Every
// camelCase name, every resource class and every import wrapper is built here,
// at instantiate time, from the loaded plan's type tables — the plan already
// carries names, kinds and function types. Bindgen emits compile-time *types*
// that cast this facade; no generated code participates, so everything works
// fully untyped.
//
// Governing contract: contracts/embedder-api.md (all sections). Secondary:
// contracts/plan-format.md for the wire shapes read here.

import type { WirePlan, WireExport } from "../plan/format.ts";
import type { LoadedPlan } from "../plan/loader.ts";
import { loadPlan, PlanError } from "../plan/loader.ts";
import type { FuncType, ResourceTypeInfo, ValType } from "../cabi/types.ts";
import type { ComponentValue } from "../cabi/types.ts";
import { Trap } from "../cabi/trap.ts";
import {
  type ComponentHandle,
  hostResourceType,
  type HostImports,
  instantiateComponent,
} from "../exec/mod.ts";
import { camelCase, parseLeafName, pascalCase } from "./casing.ts";
import { NameCollisionError, WitError } from "./errors.ts";
import { type ImportLeaf, requiredImports } from "./imports.ts";
import {
  buildGuestResourceClass,
  type GuestResourceSpec,
  HostResourceRegistry,
  invalidateWrapper,
  makeWrapper,
  takeRep,
} from "./resources.ts";
import {
  type AdapterOptions,
  BorrowScope,
  describe,
  fromHost,
  toHost,
  type ValueBridge,
} from "./values.ts";
import { ImportResolver } from "./version.ts";
import { type ElemCodec, Future } from "./streams.ts";

/** Per-element codec for a `future<T>` returned in function-result position. */
function elementCodec(
  element: ValType | null,
  o: AdapterOptions,
): ElemCodec<unknown> {
  return {
    element,
    where: o.where,
    toHost: (v) => element === null ? undefined : toHost(v, element, o),
    fromHost: (v) => element === null ? null : fromHost(v, element, o),
  };
}

/** The shim's output plus the component bytes it describes. */
export interface ComponentArtifacts {
  plan: WirePlan;
  componentBytes: Uint8Array;
  adapters?: Map<string, Uint8Array>;
}

export interface EmbedderOptions {
  /** Opt in to JSPI-backed suspension (see `InstantiateInput.jspi`). */
  jspi?: boolean;
  /** Verify `plan.component.sha256` against the bytes (default true). */
  verifyHash?: boolean;
}

/** An instantiated component, conventions-shaped. */
export interface EmbedderInstance {
  /**
   * Nested record keyed by verbatim WIT interface id; world-level exports at
   * the top level under camelCase names.
   */
  // deno-lint-ignore no-explicit-any
  exports: Record<string, any>;
  /** The raw runtime handle. Internal surface, no stability promise. */
  handle: ComponentHandle;
  /** The leaves this component required (the same list `requiredImports` gives). */
  imports: ImportLeaf[];
}

type RawFn = (...a: unknown[]) => unknown;

/** How a resource type is implemented, keyed by `ResourceIndex`. */
type Binding =
  | { kind: "guest"; name: string; cls?: unknown }
  | { kind: "host"; name: string; registry: HostResourceRegistry; cls: unknown };

/**
 * Instantiate a component behind the embedder conventions.
 *
 * `imports` is the canonical nested record of
 * contracts/embedder-api.md §"Module wiring and instantiation": keys are
 * verbatim WIT interface ids (version included) or world-level camelCase
 * names; interface-id keys additionally participate in compatibility-track
 * resolution (see `version.ts`).
 */
export async function instantiate(
  artifacts: ComponentArtifacts,
  imports: Record<string, unknown> = {},
  opts: EmbedderOptions = {},
): Promise<EmbedderInstance> {
  const facade = new Facade(artifacts, imports);
  const handle = await instantiateComponent({
    plan: artifacts.plan,
    componentBytes: artifacts.componentBytes,
    adapters: artifacts.adapters,
    imports: facade.rawImports,
    jspi: opts.jspi,
    verifyHash: opts.verifyHash,
    // THE ordering fix: the facade converted this plan in its constructor and
    // wired its import wrappers against those very `ResourceTypeInfo` tokens.
    // Host imports fire DURING instantiation (a core module's `start`
    // function runs inside `runInitializers`), so the facade cannot wait for
    // the handle to learn its own types.
    loadedPlan: facade.loaded,
  });
  facade.bind(handle);
  const instance: EmbedderInstance = {
    exports: facade.buildExports(handle),
    handle,
    imports: facade.leaves,
  };
  Object.defineProperty(instance, INTERNAL_HOST_REGISTRIES, {
    value: facade.hostRegistries,
    enumerable: false,
  });
  return instance;
}

/** Alias matching the C2 dispatch's spelling. */
export const instantiateEmbedder = instantiate;

/**
 * Symbol-keyed, deliberately NOT re-exported from `mod.ts`: the
 * host-resource registries of an instance, by `ResourceIndex`. Diagnostics and
 * white-box tests only — it is not part of the embedder API surface and no
 * generated code may depend on it.
 */
export const INTERNAL_HOST_REGISTRIES = Symbol(
  "component-engine.embedder.hostRegistries",
);

class Facade {
  readonly leaves: ImportLeaf[];
  readonly rawImports: HostImports = {};
  readonly #resolver: ImportResolver;
  readonly #bindings = new Map<number, Binding>();
  /** ResourceTypeInfo identity -> ResourceIndex (one index, many tokens). */
  readonly #tokenIndex = new Map<ResourceTypeInfo, number>();
  /**
   * The converted plan — owned by the facade and handed to the executor, so
   * both sides share one set of per-instantiation resource identity tokens.
   * Available from construction, which is what makes import wrappers usable
   * for the whole of instantiation.
   */
  readonly loaded: LoadedPlan;
  readonly #bridge: ValueBridge;
  /**
   * Releases for reps minted while lowering the CURRENT call's arguments.
   * Argument lowering is synchronous and uninterrupted (no `await` between
   * `#lowerScope = […]` and the reset), so a single slot is race-free even
   * with concurrent export calls in flight.
   */
  #lowerScope: (() => void)[] | null = null;
  /** ResourceIndex -> registry, for diagnostics (see INTERNAL_HOST_REGISTRIES). */
  readonly hostRegistries = new Map<number, HostResourceRegistry>();
  /** True once `buildExports` has run: guest resource classes then exist. */
  #exportsBuilt = false;

  constructor(
    readonly artifacts: ComponentArtifacts,
    providers: Record<string, unknown>,
  ) {
    this.#resolver = new ImportResolver(providers);
    this.loaded = loadPlan(artifacts.plan);
    // `ResourceTypeInfo` identity -> `ResourceIndex`. Both halves are static
    // (the tokens are ours; `resourceTables` is wire data), so this map is
    // complete before instantiation starts — a host import that fires from a
    // guest `start` function can resolve resource types normally.
    //
    // One resource TYPE can be reached through several resource TABLES
    // (plan-format.md C2 amendment #1: a type export's index is a table
    // index, and the executor sets impl/dtor on every table whose `resource`
    // matches), hence index-keyed bindings with tokens as aliases.
    artifacts.plan.resourceTables.forEach((table, i) => {
      if (table.kind !== "concrete") return;
      const token = this.loaded.resourceTokens[i];
      if (token !== undefined) this.#tokenIndex.set(token, table.resource);
    });
    this.leaves = requiredImports(this.loaded);
    // A component that imports a resource TYPE cannot be wired without
    // `plan.importedResources`: that table is the only thing mapping the
    // import back to a `ResourceIndex` (plan-format.md v0.1 amendment #2 /
    // v0.2). Without it every own/borrow of that type would fail late, deep
    // inside a call, as an unattributable `InvalidHandleError`.
    const resourceLeaves = this.leaves.filter((l) => l.kind === "resource");
    if (
      resourceLeaves.length > 0 &&
      (artifacts.plan.importedResources ?? []).length === 0
    ) {
      throw new PlanError(
        `this component imports the resource type(s) ` +
          `${resourceLeaves.map((l) => `'${l.leaf}'`).join(", ")}, but the ` +
          `plan carries no \`importedResources\` table, so they cannot be ` +
          `bound to a ResourceIndex (contracts/plan-format.md v0.2). ` +
          `Re-translate with a shim that emits it.`,
      );
    }
    this.#bridge = this.#makeBridge();
    this.#buildRawImports();
    this.#bindHostResources();
  }

  // -- resource-type identity ------------------------------------------------

  /**
   * Consistency check after instantiation.
   *
   * The facade no longer *learns* anything here — it handed its own
   * `LoadedPlan` to the executor precisely so that nothing about types or
   * resource identity depends on instantiation having finished. All this does
   * is assert the executor did not silently re-load (which would give it a
   * second, disjoint set of `ResourceTypeInfo` tokens and make every
   * `own`/`borrow` unresolvable).
   */
  bind(handle: ComponentHandle): void {
    if (handle.loadedPlan !== this.loaded) {
      throw new PlanError(
        "the executor instantiated from a different LoadedPlan than the " +
          "facade built its import wrappers from; resource identity tokens " +
          "would not match",
      );
    }
  }

  #indexOf(rt: ResourceTypeInfo): number {
    const i = this.#tokenIndex.get(rt);
    if (i === undefined) {
      throw new PlanError(
        "resource type is not bound to any resource table in this plan",
      );
    }
    return i;
  }

  #binding(rt: ResourceTypeInfo): Binding {
    const index = this.#indexOf(rt);
    let b = this.#bindings.get(index);
    if (b === undefined) {
      // A GUEST-implemented resource. Unlike host-implemented ones (bound at
      // construction from static plan data), a guest resource's class is
      // assembled from the component's own lifted `[constructor]`/`[method]`
      // exports, which do not exist until instantiation has finished. If a
      // guest `start` function hands one to a host import, say so precisely
      // rather than surfacing a half-built wrapper.
      if (!this.#exportsBuilt) {
        throw new PlanError(
          `a guest-implemented resource (ResourceIndex ${index}) crossed the ` +
            `boundary before instantiation finished — a guest \`start\` ` +
            `function passed an own/borrow handle to a host import. Its class ` +
            `is assembled from the component's own lifted exports, which do ` +
            `not exist yet. Host-implemented resources are unaffected. If a ` +
            `real component needs this, the class must be built lazily from ` +
            `the plan's export table instead of the runtime's export surface.`,
        );
      }
      // Post-instantiation: a guest resource with no exported type and no
      // exported leaves. Still a valid handle, just anonymous.
      b = { kind: "guest", name: `resource-${index}` };
      this.#bindings.set(index, b);
    }
    return b;
  }

  // deno-lint-ignore no-explicit-any
  #guestClass(b: Binding & { kind: "guest" }): any {
    b.cls ??= buildGuestResourceClass(
      { name: b.name, ctor: null, ctorParams: null, methods: [], statics: [] },
      // The rt is supplied per wrapper, so an anonymous class needs none here.
      { impl: null, dtor: null } as unknown as ResourceTypeInfo,
      () => Promise.reject(new TypeError("no methods")),
      () => [],
    );
    return b.cls;
  }

  /**
   * Bind host-implemented resource types to their `ResourceIndex`.
   *
   * Everything this needs is static wire data (`plan.importedResources`, whose
   * entries are back-references into `plan.imports`), so it runs at
   * construction — before instantiation, and therefore before a guest `start`
   * function can call an import that carries an `own`/`borrow` of one.
   * Imported resources occupy `ResourceIndex` 0..n-1 in `importedResources`
   * order (plan-format.md v0.1 amendment #2 / v0.2).
   */
  #bindHostResources(): void {
    const importedResources = this.artifacts.plan.importedResources ?? [];
    for (const p of this.#pendingHostResources) {
      const at = importedResources.findIndex((ir) => ir.import === p.importIndex);
      if (at < 0) continue;
      this.#bindings.set(at, {
        kind: "host",
        name: this.leaves[p.importIndex].leaf,
        registry: p.registry,
        cls: p.cls,
      });
      this.hostRegistries.set(at, p.registry);
    }
  }

  // -- the value bridge ------------------------------------------------------

  #makeBridge(): ValueBridge {
    const self = this;
    return {
      liftOwn(rep, t) {
        const b = self.#binding(t.rt);
        // Host-implemented R: "the host's own instance back; the guest's
        // handle is gone; no dispose call" (contract 2x4 table).
        if (b.kind === "host") return b.registry.release(rep);
        return makeWrapper(self.#guestClass(b), rep, t.rt, true);
      },
      liftBorrow(rep, t, scope) {
        const b = self.#binding(t.rt);
        // Host-implemented R: "the host's own instance; borrow scoping is
        // guest-side bookkeeping" — the mapping is kept.
        if (b.kind === "host") return b.registry.lookup(rep);
        const w = makeWrapper(self.#guestClass(b), rep, t.rt, false);
        scope.add(() => invalidateWrapper(w));
        return w;
      },
      lowerOwn(v, t) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") return b.registry.repFor(v);
        return takeRep(v, true, `own<${b.name}>`);
      },
      lowerBorrow(v, t) {
        const b = self.#binding(t.rt);
        if (b.kind === "host") {
          // Contract 2x4 table, bottom-right: "a never-registered instance
          // gets a rep allocated **for the call's duration**". A rep minted
          // here is call-scoped, so it is released when the call returns —
          // otherwise it would sit in the registry's STRONG rep->instance map
          // forever, since a guest dropping a borrow handle runs no dtor.
          const known = b.registry.hasInstance(v);
          const rep = b.registry.repFor(v);
          if (!known) {
            self.#lowerScope?.push(() => b.registry.releaseIfPresent(rep));
          }
          return rep;
        }
        return takeRep(v, false, `borrow<${b.name}>`);
      },
    };
  }

  #opts(where: string): AdapterOptions {
    return { bridge: this.#bridge, where };
  }

  #funcType(index: number | undefined, what: string): FuncType {
    const loaded = this.loaded;
    if (index === undefined) throw new PlanError(`${what}: no type index`);
    const t = loaded.types[index];
    if (t === undefined || t.kind !== "func") {
      throw new PlanError(`${what}: type ${index} is not a function type`);
    }
    return t.funcType;
  }

  // -- imports ---------------------------------------------------------------

  #buildRawImports(): void {
    // Group by the record key so an instance import lands as one nested object.
    this.leaves.forEach((leaf, importIndex) => {
      const provider = this.#provider(leaf);
      const target = leaf.path.length === 0
        ? null
        : nest(this.rawImports, leaf.interfaceId, leaf.path.slice(0, -1));
      const value = this.#wrapLeaf(leaf, importIndex, provider);
      if (target === null) this.rawImports[leaf.interfaceId] = value;
      else target[leaf.path[leaf.path.length - 1]] = value;
    });
  }

  /** Resolve the container object a leaf's implementation is read from. */
  #provider(leaf: ImportLeaf): unknown {
    const hit = this.#resolver.resolve(leaf.interfaceId) ??
      (leaf.path.length === 0
        ? this.#resolver.resolve(camelCase(leaf.interfaceId))
        : undefined);
    if (hit === undefined) {
      throw new PlanError(
        `host import '${label(leaf)}' not provided (no key ` +
          `'${leaf.interfaceId}' in imports; registered: ` +
          `${this.#resolver.keys().join(", ") || "<none>"})`,
      );
    }
    let value = hit.value;
    // Walk everything but the final segment; the leaf itself is read by
    // `#wrapLeaf`, which knows how to decode a mangled name.
    for (const seg of leaf.path.slice(0, -1)) {
      if (value === null || typeof value !== "object") {
        throw new PlanError(
          `host import '${label(leaf)}': '${seg}' is not reachable ` +
            `(${describe(value)})`,
        );
      }
      value = (value as Record<string, unknown>)[seg];
    }
    return value;
  }

  #wrapLeaf(
    leaf: ImportLeaf,
    importIndex: number,
    provider: unknown,
  ): unknown {
    if (leaf.kind === "resource") {
      return this.#wrapResourceType(leaf, importIndex, provider);
    }
    if (leaf.kind !== "func") {
      // `instance` leaves never appear as plan imports in their own right
      // (the plan flattens them into paths); anything else is out of scope.
      throw new PlanError(
        `host import '${label(leaf)}': unsupported import kind '${leaf.kind}'`,
      );
    }
    const dispatch = this.#dispatcher(leaf, provider);
    // The function type is resolved LAZILY, on first call. It must come from
    // the *executor's* loaded plan: the `own`/`borrow` types in it carry the
    // per-instantiation `ResourceTypeInfo` identity tokens the bridge keys on,
    // and those objects do not exist until `instantiateComponent` has run —
    // which is after this wrapper has to be handed to it.
    let impl: RawFn | null = null;
    return (...raw: unknown[]) => {
      if (impl === null) {
        const ft = this.#funcType(
          this.artifacts.plan.imports[importIndex].type,
          `import '${label(leaf)}'`,
        );
        impl = this.#wrapImportFn(leaf, ft, dispatch);
      }
      return impl(...raw);
    };
  }

  /** A host-implemented resource type: register the class, own the mapping. */
  #wrapResourceType(
    leaf: ImportLeaf,
    importIndex: number,
    provider: unknown,
  ): unknown {
    // `#provider` already walked every path segment but the last, so a
    // path-bearing resource import reads its class off `provider`; a
    // world-level one IS `provider`.
    const cls = leaf.path.length === 0
      ? provider
      : pick(provider, [], [pascalCase(leaf.leaf), leaf.leaf]);
    if (cls === undefined) {
      throw new PlanError(
        `host import '${label(leaf)}': the component imports the resource ` +
          `type '${leaf.leaf}'; provide the implementing class as ` +
          `'${pascalCase(leaf.leaf)}'`,
      );
    }
    const registry = new HostResourceRegistry(pascalCase(leaf.leaf));
    this.#pendingHostResources.push({ importIndex, registry, cls });
    return hostResourceType({
      name: leaf.leaf,
      // The guest dropped its last own handle: run the destructor, which for
      // a host-implemented resource is `instance[Symbol.dispose]?.()`.
      dtor: (rep) => registry.dtor(rep),
    });
  }

  readonly #pendingHostResources: {
    importIndex: number;
    registry: HostResourceRegistry;
    cls: unknown;
  }[] = [];

  /** The JS call a lifted import leaf dispatches to. */
  #dispatcher(leaf: ImportLeaf, provider: unknown): (args: unknown[]) => unknown {
    const m = leaf.member;
    if (m.form === "plain") {
      const fn = leaf.path.length === 0
        ? provider
        : pick(provider, [], [camelCase(m.name), m.name]);
      if (typeof fn !== "function") {
        throw new PlanError(
          `host import '${label(leaf)}' missing or not a function (got ` +
            `${describe(fn)}); expected '${camelCase(m.name)}'`,
        );
      }
      return (args) => (fn as RawFn)(...args);
    }
    const clsName = pascalCase(m.resource);
    const cls = pick(provider, [], [clsName, m.resource]);
    if (cls === undefined) {
      throw new PlanError(
        `host import '${label(leaf)}': no class '${clsName}' provided`,
      );
    }
    switch (m.form) {
      case "constructor":
        // deno-lint-ignore no-explicit-any
        return (args) => new (cls as any)(...args);
      case "method":
        return (args) => {
          const [self, ...rest] = args;
          const fn = (self as Record<string, unknown>)?.[camelCase(m.member)];
          if (typeof fn !== "function") {
            throw new Trap(
              `host import '${label(leaf)}': the ${clsName} instance has no ` +
                `method '${camelCase(m.member)}'`,
            );
          }
          return (fn as RawFn).apply(self, rest);
        };
      case "static": {
        const fn = (cls as Record<string, unknown>)[camelCase(m.member)];
        if (typeof fn !== "function") {
          throw new PlanError(
            `host import '${label(leaf)}': ${clsName} has no static ` +
              `'${camelCase(m.member)}'`,
          );
        }
        return (args) => (fn as RawFn).apply(cls, args);
      }
    }
  }

  /**
   * The raw (definitions.py-shaped) function the executor lowers, wrapping a
   * conventions-shaped host implementation.
   *
   * Error model (contract §"Error model"), the inversion of jco's convention:
   *   * a returned value is the ok side;
   *   * `throw new WitError(payload)` is the err side of a `result<T, E>`;
   *   * a `Trap` passes through unchanged;
   *   * **any other throw is a host bug and becomes a trap naming the import**
   *     — never a guest-visible err. This is what makes the consumers'
   *     defensive `platformCall`-style wrappers unnecessary by construction.
   */
  #wrapImportFn(
    leaf: ImportLeaf,
    ft: FuncType,
    dispatch: (args: unknown[]) => unknown,
  ): RawFn {
    const where = `import '${label(leaf)}'`;
    const o = this.#opts(where);
    const resultType = ft.results.length === 0 ? null : ft.results[0];
    const isResult = resultType !== null && resultType.kind === "result";

    const ok = (v: unknown): ComponentValue | undefined => {
      if (resultType === null) return undefined;
      if (isResult) {
        const rt = resultType as ValType & { kind: "result" };
        return { ok: rt.ok === null ? null : fromHost(v, rt.ok, o) };
      }
      return fromHost(v, resultType, o);
    };
    const fail = (e: unknown): ComponentValue => {
      if (e instanceof Trap) throw e;
      if (e instanceof WitError && isResult) {
        const rt = resultType as ValType & { kind: "result" };
        return {
          error: rt.error === null ? null : fromHost(e.payload, rt.error, o),
        };
      }
      if (e instanceof WitError) {
        throw new Trap(
          `${where} threw a WitError, but its WIT type has no err side; ` +
            `only a fallible import may signal an error value`,
        );
      }
      throw new Trap(
        `${where} threw ${describeThrow(e)}. An unbranded throw from a host ` +
          `import is a host bug and becomes a trap: signal a WIT error with ` +
          `\`throw new WitError(payload)\`.`,
      );
    };

    return (...raw: unknown[]) => {
      const scope = new BorrowScope();
      const args = ft.params.map((p, i) =>
        toHost(raw[i] as ComponentValue, p, o, scope)
      );
      let out: unknown;
      try {
        out = dispatch(args);
      } catch (e) {
        scope.end();
        return fail(e);
      }
      if (isThenable(out)) {
        return (out as PromiseLike<unknown>).then(
          (v) => {
            scope.end();
            return ok(v);
          },
          (e) => {
            scope.end();
            return fail(e);
          },
        );
      }
      scope.end();
      return ok(out);
    };
  }

  // -- exports ---------------------------------------------------------------

  // deno-lint-ignore no-explicit-any
  buildExports(handle: ComponentHandle): Record<string, any> {
    this.#exportsBuilt = true;
    // deno-lint-ignore no-explicit-any
    const out: Record<string, any> = {};
    const worldLeaves: WireExport[] = [];
    for (const exp of this.artifacts.plan.exports) {
      if (exp.kind === "instance") {
        out[exp.name] = this.#buildInterface(
          exp.name,
          exp.exports,
          handle.exports[exp.name] as Record<string, unknown>,
        );
      } else {
        worldLeaves.push(exp);
      }
    }
    if (worldLeaves.length > 0) {
      Object.assign(
        out,
        this.#buildInterface("", worldLeaves, handle.exports),
      );
    }
    return out;
  }

  // deno-lint-ignore no-explicit-any
  #buildInterface(
    id: string,
    exps: WireExport[],
    raw: Record<string, unknown>,
    // deno-lint-ignore no-explicit-any
  ): Record<string, any> {
    // deno-lint-ignore no-explicit-any
    const obj: Record<string, any> = {};
    /** jsName -> the WIT leaf that claimed it (camelCase collision guard). */
    const claimed = new Map<string, string>();
    const claim = (js: string, leaf: string): string => {
      const held = claimed.get(js);
      if (held !== undefined) {
        throw new NameCollisionError(
          `export '${id || "<world>"}': the leaves '${held}' and '${leaf}' ` +
            `both map to the JS name '${js}'. Rename one in the WIT; the ` +
            `conventions layer will not guess which one wins.`,
        );
      }
      claimed.set(js, leaf);
      return js;
    };
    const specs = new Map<string, GuestResourceSpec>();
    const specRt = new Map<string, ResourceTypeInfo>();
    const spec = (name: string): GuestResourceSpec => {
      let s = specs.get(name);
      if (s === undefined) {
        s = { name, ctor: null, ctorParams: null, methods: [], statics: [] };
        specs.set(name, s);
      }
      return s;
    };

    for (const exp of exps) {
      if (exp.kind === "type") {
        // A `resource` type export names the class; the ResourceIndex comes
        // from the resource TABLE it points at (the wire field is a table
        // index, like `own`/`borrow`).
        if (exp.type.kind === "resource") {
          const token = this.loaded.resourceTokens[exp.type.resource];
          if (token !== undefined && this.#tokenIndex.has(token)) {
            const index = this.#tokenIndex.get(token)!;
            const held = this.#bindings.get(index);
            if (held === undefined) {
              this.#bindings.set(index, { kind: "guest", name: exp.name });
            } else if (held.kind === "guest") {
              held.name = exp.name;
            }
          }
        }
        continue;
      }
      if (exp.kind === "instance") {
        // The plan flattens the world's instance exports at the top level; a
        // nested one would need a nested facade, which nothing produces today.
        // Refuse rather than silently drop the whole sub-interface.
        throw new PlanError(
          `export '${id || "<world>"}/${exp.name}': nested instance exports ` +
            `are not surfaced by the conventions layer (only one level of ` +
            `interface nesting exists in plan v2)`,
        );
      }
      if (exp.kind !== "lifted-func") {
        throw new PlanError(
          `export '${id || "<world>"}/${(exp as { name?: string }).name}': ` +
            `unsupported export kind ` +
            `'${(exp as { kind: string }).kind}'`,
        );
      }
      const fn = raw[exp.name] as RawFn | undefined;
      if (typeof fn !== "function") {
        throw new PlanError(
          `export '${id || "<world>"}/${exp.name}': the runtime produced no ` +
            `callable for this lifted function`,
        );
      }
      const ft = this.#funcType(exp.type, `export '${id}/${exp.name}'`);
      const member = parseLeafName(exp.name);
      const where = id === "" ? exp.name : `${id}#${exp.name}`;
      switch (member.form) {
        case "plain":
          obj[claim(camelCase(member.name), member.name)] = this
            .#wrapExportFn(fn, ft, where);
          break;
        case "constructor": {
          const s = spec(member.resource);
          s.ctor = fn;
          s.ctorParams = ft.params;
          rtOf(ft.results[0], specRt, member.resource);
          break;
        }
        case "method": {
          spec(member.resource).methods.push({
            member: member.member,
            raw: fn,
            params: ft.params,
            results: ft.results,
          });
          rtOf(ft.params[0], specRt, member.resource);
          break;
        }
        case "static": {
          spec(member.resource).statics.push({
            member: member.member,
            raw: fn,
            params: ft.params,
            results: ft.results,
          });
          break;
        }
      }
    }

    for (const [name, s] of specs) {
      const rt = specRt.get(name);
      if (rt === undefined) {
        throw new PlanError(
          `export '${id}': resource '${name}' has leaves but no own/borrow ` +
            `type to identify it by`,
        );
      }
      const cls = buildGuestResourceClass(
        s,
        rt,
        (fn, params, results, where, args) =>
          this.#wrapExportFn(fn, { params, results }, where)(...args) as Promise<
            unknown
          >,
        (args, params, where) =>
          args.map((a, i) => fromHost(a, params[i], this.#opts(where))),
      );
      obj[claim(pascalCase(name), name)] = cls;
      const index = this.#tokenIndex.get(rt);
      if (index !== undefined) {
        this.#bindings.set(index, { kind: "guest", name, cls });
      }
    }
    return obj;
  }

  /**
   * Lower a call's arguments, collecting the releases for anything that was
   * allocated *for the duration of this call* (see `lowerBorrow`).
   *
   * The collection window is the synchronous argument-lowering phase only —
   * `#lowerScope` is set and cleared with no `await` in between — so a single
   * slot is correct even with concurrent export calls in flight.
   */
  #lowerParams(
    params: ValType[],
    args: unknown[],
    o: AdapterOptions,
  ): { lowered: ComponentValue[]; release: () => void } {
    const scope: (() => void)[] = [];
    const outer = this.#lowerScope;
    this.#lowerScope = scope;
    let lowered: ComponentValue[];
    try {
      lowered = params.map((p, i) => fromHost(args[i], p, o));
    } catch (e) {
      for (const r of scope) r();
      throw e;
    } finally {
      this.#lowerScope = outer;
    }
    let released = false;
    return {
      lowered,
      release: () => {
        if (released) return;
        released = true;
        for (const r of scope) r();
      },
    };
  }

  /**
   * Wrap one lifted export.
   *
   * Uniformly Promise-shaped (contract §"Functions and async"): a sync
   * completion resolves immediately, so there is one calling convention.
   * A `result<T, E>` in *function-result* position resolves `T` or rejects
   * `WitError<E>`; a result nested inside a value is plain `{tag, val}` data
   * and never throws.
   */
  #wrapExportFn(
    fn: RawFn,
    ft: { params: ValType[]; results: ValType[] },
    where: string,
  ): (...args: unknown[]) => Promise<unknown> {
    const o = this.#opts(where);
    const resultType = ft.results.length === 0 ? null : ft.results[0];
    if (resultType !== null && resultType.kind === "future") {
      // See `Future.deferred`: a `future<T>` result cannot be delivered
      // *through* a Promise, because promise resolution adopts thenables and
      // `Future<T>` is one. The handle is returned eagerly instead; it is
      // PromiseLike, so `await` still yields `T`.
      const element = resultType.element;
      return (...args: unknown[]): Promise<unknown> => {
        // Advisory 9: the generic branch checks arity; so must this one.
        if (args.length !== ft.params.length) {
          throw new TypeError(
            `${where}: expected ${ft.params.length} argument(s), got ` +
              `${args.length}`,
          );
        }
        const { lowered, release } = this.#lowerParams(ft.params, args, o);
        let pending: Promise<ComponentValue>;
        try {
          pending = Promise.resolve(fn(...lowered)) as Promise<ComponentValue>;
        } catch (e) {
          release();
          throw e;
        }
        void pending.then(release, release);
        return Future.deferred(
          pending,
          elementCodec(element, o),
        ) as unknown as Promise<unknown>;
      };
    }
    return async (...args: unknown[]): Promise<unknown> => {
      if (args.length !== ft.params.length) {
        throw new TypeError(
          `${where}: expected ${ft.params.length} argument(s), got ${args.length}`,
        );
      }
      const { lowered, release } = this.#lowerParams(ft.params, args, o);
      let raw: unknown;
      try {
        raw = await fn(...lowered);
      } finally {
        // Call-scoped reps minted for `borrow<R>` arguments of a
        // host-implemented resource live exactly as long as the call.
        release();
      }
      if (resultType === null) return undefined;
      if (resultType.kind === "result") {
        const v = raw as Record<string, ComponentValue>;
        if ("error" in v) {
          throw new WitError(
            resultType.error === null
              ? undefined
              : toHost(v["error"], resultType.error, o),
          );
        }
        return resultType.ok === null
          ? undefined
          : toHost(v["ok"], resultType.ok, o);
      }
      return toHost(raw as ComponentValue, resultType, o);
    };
  }
}

// ---------------------------------------------------------------------------

function rtOf(
  t: ValType | undefined,
  into: Map<string, ResourceTypeInfo>,
  name: string,
): void {
  if (t === undefined) return;
  if (t.kind === "own" || t.kind === "borrow") into.set(name, t.rt);
}

function label(leaf: ImportLeaf): string {
  return leaf.path.length === 0
    ? leaf.interfaceId
    : `${leaf.interfaceId}/${leaf.path.join("/")}`;
}

function nest(
  root: Record<string, unknown>,
  key: string,
  path: string[],
): Record<string, unknown> {
  let cur = (root[key] ??= {}) as Record<string, unknown>;
  for (const seg of path) {
    cur = (cur[seg] ??= {}) as Record<string, unknown>;
  }
  return cur;
}

/** Read `names` in order from `container` after walking `path`. */
function pick(
  container: unknown,
  path: string[],
  names: string[],
): unknown {
  let v = container;
  for (const seg of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  if (v === null || typeof v !== "object") {
    return names.length === 0 ? v : undefined;
  }
  for (const n of names) {
    const hit = (v as Record<string, unknown>)[n];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function isThenable(v: unknown): boolean {
  return v !== null && typeof v === "object" && "then" in v &&
    typeof (v as { then: unknown }).then === "function";
}

function describeThrow(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return describe(e);
}

