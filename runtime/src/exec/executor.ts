// Plan executor (PLAN.md §4.3 item 1): compile sliced core modules and FACT
// adapters, run the plan's `initializers` strictly in order, wire the
// component's typed export surface through the task model.
//
// Executor obligations implemented per contracts/plan-format.md:
//   - formatVersion validation (via plan loader), fail fast
//   - strict initializer order; semantics per wasmtime GlobalInitializer
//   - instantiate-time (not call-time) failure for unsupported trampolines /
//     ops (milestone-aware, contracts/intrinsics.md)
//   - component hash verification against plan.component

import type { ComponentValue, FuncType, ValType } from "../cabi/types.ts";
import { ComponentInstanceState, Store } from "../task/mod.ts";
import {
  assertModeConsistent,
  chooseMode,
  planNeedsSuspension,
  suspendingImport,
  type SuspensionMode,
} from "../jspi/mod.ts";

/**
 * Trampoline kinds that can block a wasm frame, and so are handed to wasm as
 * `Suspending` imports in jspi mode. Mirrors `planNeedsSuspension`'s list —
 * the two must agree, or a component could be judged "needs suspension" while
 * the built-in it needs it for is imported plainly.
 */
const BLOCKING_TRAMPOLINES: ReadonlySet<string> = new Set([
  "sync-start-call",
  "waitable-set-wait",
  "thread-yield",
  "subtask-cancel",
  "stream-read",
  "stream-write",
  "future-read",
  "future-write",
  "stream-cancel-read",
  "stream-cancel-write",
  "future-cancel-read",
  "future-cancel-write",
]);
import {
  loadPlan,
  PlanError,
  resourceIndexOfDefined,
} from "../plan/loader.ts";
import { PendingCapability } from "../task/mod.ts";
import type {
  WireCanonicalOptions,
  WireCoreDef,
  WireCoreExport,
  WireExport,
  WirePlan,
  WireTrampoline,
} from "../plan/format.ts";
import type { LoadedPlan, LoadedType } from "../plan/loader.ts";
import {
  type CoreFn,
  createLiftedFunction,
  createLoweredImport,
  type ExecutionStats,
  LiveMemory,
  newStats,
  type ResolvedOptions,
} from "./boundary.ts";
import {
  createTrampoline,
  createUnsafeIntrinsic,
  type PreparedCall,
  type HostTrapState,
  type SyncCallScope,
  TranscodeMemory,
} from "../intrinsics/mod.ts";

/**
 * Host-provided imports: a nested record keyed by the component's *exact*
 * import strings. A plan import with a non-empty `path` (an item extracted
 * from an imported instance — plan-format.md v0.1 amendment #4) is looked up
 * by walking `imports[name]` then each path segment in order. So an import
 * of `"ns:pkg/iface"` exposing `f` is supplied as
 * `{ "ns:pkg/iface": { f: (…) => … } }`.
 *
 * Leaf values by import kind:
 *   - `func`     — a JS function; arguments/results are host-shaped
 *                  component values (contracts/descriptor-ir.md).
 *   - `resource` — a `HostResourceType` (see `hostResourceType`).
 *   - `instance` — a plain object; only its leaves are ever read.
 *   - `module`   — not supported (see `InstantiateModule::Import` below).
 */
export type HostImports = Record<string, unknown>;

/**
 * Identity token for a resource type **defined by the host** and imported by
 * a component (plan `importedResources`). One object per resource type;
 * object identity is the type identity, exactly as for guest-defined
 * resources whose identity is the per-instantiation `ResourceTypeInfo`.
 */
export class HostResourceType {
  constructor(
    readonly options: {
      /** Debug name, used in error messages only. */
      readonly name?: string;
      /**
       * Destructor for handles owned by a component and dropped there.
       * Per PLAN.md §7 / CanonicalABI.md `canon resource.drop`, it runs
       * synchronously and may not block.
       */
      readonly dtor?: (rep: number) => void;
    } = {},
  ) {}
}

/** Convenience constructor for {@link HostResourceType}. */
export function hostResourceType(
  options?: HostResourceType["options"],
): HostResourceType {
  return new HostResourceType(options ?? {});
}

export interface InstantiateInput {
  plan: WirePlan;
  /** The original component binary (embedded modules are sliced from it). */
  componentBytes: Uint8Array;
  /** FACT adapter artifacts keyed by `plan.modules[].file`. */
  adapters?: Map<string, Uint8Array>;
  imports?: HostImports;
  /** Verify plan.component.sha256 against componentBytes (default true). */
  verifyHash?: boolean;
  /**
   * Opt in to JSPI-backed suspension (PLAN.md §6 role 1-3).
   *
   * Off by default, and deliberately so: in this mode every lifted export
   * returns a Promise (empirical fact (e) — `WebAssembly.promising` always
   * does), which is an API-shape change. Ignored on an engine without JSPI,
   * where every blocking site keeps raising the precise `NeedsJspi` it raises
   * today (the M3 degradation path).
   */
  jspi?: boolean;
}

/** An instantiated component: its export surface plus introspection state. */
export interface ComponentHandle {
  /** Lifted functions / nested instance objects, by export name. */
  exports: Record<string, unknown>;
  stats: ExecutionStats;
  componentInstances: ComponentInstanceState[];
  coreInstances: WebAssembly.Instance[];
  /** See `Executor.suspendableFuncs`. */
  suspendableFuncs: WeakSet<object>;
  taskMayBlock: WebAssembly.Global;
  /** `ResourceIndex` -> the `HostResourceType` bound to it, if any. */
  hostResourceTypes: Map<number, HostResourceType>;
  /**
   * Plan exports deliberately absent from `exports`, by export path, with the
   * reason. Only `type` exports appear here; a missing *function* export is
   * always an error, never an omission (see `Executor.buildExport`).
   */
  omittedExports: Map<string, string>;
}

export async function instantiateComponent(
  input: InstantiateInput,
): Promise<ComponentHandle> {
  // Re-load per instantiation: resource identity tokens must be fresh per
  // component instance (descriptor-ir.md open item on ResourceTypeInfo).
  const loaded = loadPlan(input.plan);
  const executor = new Executor(loaded, input);
  await executor.verifyComponent();
  await executor.compileModules();
  executor.bindImportedResources();
  await executor.runInitializers();
  return executor.finish();
}

type Importable =
  | WebAssembly.Suspending
  | CoreFn
  | WebAssembly.Global
  | WebAssembly.Memory
  | WebAssembly.Table;

class Executor {
  readonly wire: WirePlan;
  readonly loaded: LoadedPlan;
  readonly componentBytes: Uint8Array;
  readonly adapterBytes: Map<string, Uint8Array>;
  readonly hostImports: HostImports;
  readonly verifyHash: boolean;
  /** See `InstantiateInput.jspi` and jspi/bridge.ts's invariant. */
  readonly suspensionMode: SuspensionMode;

  readonly stats: ExecutionStats = newStats();
  readonly modules: WebAssembly.Module[] = [];
  readonly instances: WebAssembly.Instance[] = [];
  readonly componentInstances = new Map<number, ComponentInstanceState>();
  /**
   * One scheduler `Store` for the whole component, shared by every component
   * instance in it — matching definitions.py, where a linked graph of
   * `ComponentInstance`s shares the `Store` that owns the waiting-thread list
   * (`ComponentInstance.__init__` takes `store`). A per-instance store would
   * make a thread blocked in one instance invisible to a driving loop in
   * another.
   */
  readonly store = new Store();
  /** Memoized `unsafe-intrinsic` core functions, by symbol. */
  readonly unsafeIntrinsics = new Map<string, CoreFn>();
  /** The single in-flight FACT `prepare-call` state (intrinsics/fact_calls.ts). */
  readonly preparedCall: { current: PreparedCall | null } = { current: null };
  /**
   * One `LiveMemory` per `RuntimeMemoryIndex`, memoized.
   *
   * definitions.py's `LiftOptions.equal` (line 643) compares memories by
   * *identity* (`lhs.memory is rhs.memory`), and `canon_task_return` requires
   * the options at the `task.return` site to equal the lifted export's. A
   * fresh wrapper per `resolveOptions` call would make that comparison fail
   * for every component that actually uses a memory — it only ever passed
   * before because the async fixtures in play had `memory: null` on both
   * sides. Memoizing restores wasmtime's semantics, where the comparison is
   * on `RuntimeMemoryIndex`.
   */
  readonly liveMemories = new Map<number, LiveMemory>();
  /** Set by the entry/import wrapping sites; checked in `finish`. */
  wrappedEntries = false;
  wrappedImports = false;

  /** Record that an entry / import wrapping site ran under the current mode. */
  noteEntry(): SuspensionMode {
    if (this.suspensionMode === "jspi") this.wrappedEntries = true;
    return this.suspensionMode;
  }

  noteImport(): SuspensionMode {
    if (this.suspensionMode === "jspi") this.wrappedImports = true;
    return this.suspensionMode;
  }
  readonly taskMayBlock = new WebAssembly.Global(
    { value: "i32", mutable: true },
    1,
  );

  // extract-* landing zones (index spaces per plan-format.md).
  readonly memories: WebAssembly.Memory[] = [];
  readonly reallocs: CoreFn[] = [];
  readonly postReturns: CoreFn[] = [];
  readonly callbacks: CoreFn[] = [];
  readonly tables: WebAssembly.Table[] = [];

  /** LoweredIndex -> RuntimeImportIndex (from lower-import initializers). */
  readonly lowerings = new Map<number, number>();
  readonly trampolineCache = new Map<number, CoreFn>();
  /**
   * ResourceIndex -> the host token bound to it (imported resource types).
   * Surfaced on the component handle for embedder introspection.
   */
  readonly hostResourceTypes = new Map<number, HostResourceType>();
  /** In-flight sync cross-component calls (see intrinsics `SyncCallScope`). */
  readonly syncCallStack: SyncCallScope[] = [];

  /**
   * Core functions exported by a core instance that imports at least one
   * blocking trampoline -- i.e. functions whose execution can reach a
   * suspension point. FACT consults this to decide whether a callee needs its
   * own `promising` entry; wrapping one that cannot block would force
   * asynchrony the ABI forbids (an eagerly-completing callee must report
   * RETURNED, not STARTED).
   *
   * Correct but CONSERVATIVE, and currently inert on the official corpus:
   * instance granularity is too coarse for it. `async/cross-abi-calls.wast`
   * exports all four lower/lift combinations from ONE core instance, and that
   * instance (transitively, through its FACT adapter) imports
   * `sync-start-call`, so every function it exports is marked potentially
   * blocking -- including the sync-lifted callee that cannot block. Sharpening
   * this needs per-FUNCTION reachability (which exported function can reach an
   * imported blocking trampoline), i.e. a call-graph pass over the core
   * module, which belongs in the translator where wasmparser already is.
   */
  readonly suspendableFuncs = new WeakSet<object>();

  /** Scratch: set by `importValue` while one module's imports are resolved. */
  private sawBlockingImport = false;
  /** Host trap held across a FACT exception barrier (see `HostTrapState`). */
  readonly trapState: HostTrapState = { pending: undefined };
  /** Export path -> why it has no runtime surface (see `buildExport`). */
  readonly omittedExports = new Map<string, string>();

  constructor(loaded: LoadedPlan, input: InstantiateInput) {
    this.loaded = loaded;
    this.wire = loaded.wire;
    this.componentBytes = input.componentBytes;
    this.adapterBytes = input.adapters ?? new Map();
    this.hostImports = input.imports ?? {};
    this.verifyHash = input.verifyHash ?? true;
    // AUTO-DETECTION IS DELIBERATELY OFF (jspi mode = explicit opt-in only).
    //
    // `planNeedsSuspension(loaded.wire)` computes the right answer and the
    // opt-in path works, but detection stays off while 28 async commands still
    // fail under it. The Fix-1 hang described here previously is GONE: that
    // attempt made `async-start-call` wait for callee resolution, which parked
    // the async-lowered CALLER -- precisely what async lowering exists to
    // avoid -- and hung the handshake resume path. It has been reverted; a
    // detection-on run now completes.
    //
    // 26 now, measured in one captured run (was 28; sites 2/3/5 lit):
    //   big-interleaving-test.wast  18  (11 RuntimeError, 4 NeedsJspi = the
    //                                    still-unlit stream copy sites,
    //                                    2 empty-stack, 1)
    //   cross-abi-calls.wast         6  (blocked on per-FUNCTION reachability
    //                                    -- see `suspendableFuncs`)
    //   dont-block-start             1  (start-section singleton)
    //   builtin-trap-poisons-instance 1
    // NOTE: with detection ON the async command COUNT drops 291 -> 288, i.e.
    // three commands stop being executed at all. Unexplained; check before
    // trusting any detection-on delta as complete.
    this.suspensionMode = chooseMode(input.jspi);
  }

  async verifyComponent(): Promise<void> {
    const { sha256, len } = this.wire.component;
    if (this.componentBytes.length !== len) {
      throw new PlanError(
        `component byte length ${this.componentBytes.length} != plan's ${len}`,
      );
    }
    if (!this.verifyHash) return;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      // Pass an ArrayBuffer copy: subtle.digest rejects SharedArrayBuffer
      // views and non-aligned oddities.
      this.componentBytes.slice().buffer,
    );
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hex !== sha256) {
      throw new PlanError(
        `component sha256 mismatch: plan has ${sha256}, bytes are ${hex}`,
      );
    }
  }

  async compileModules(): Promise<void> {
    const compiled = await Promise.all(this.wire.modules.map((m, i) => {
      if (m.kind === "embedded") {
        const end = m.offset + m.len;
        if (end > this.componentBytes.length) {
          throw new PlanError(
            `module ${i}: byte range ${m.offset}..${end} exceeds component ` +
              `size ${this.componentBytes.length}`,
          );
        }
        return WebAssembly.compile(
          this.componentBytes.slice(m.offset, end).buffer as ArrayBuffer,
        );
      }
      const bytes = this.adapterBytes.get(m.file);
      if (!bytes) {
        throw new PlanError(`adapter artifact ${m.file} not provided`);
      }
      if (bytes.length !== m.len) {
        throw new PlanError(
          `adapter ${m.file}: expected ${m.len} bytes, got ${bytes.length}`,
        );
      }
      return WebAssembly.compile(bytes.slice().buffer as ArrayBuffer);
    }));
    this.modules.push(...compiled);
  }

  /**
   * Bind every imported resource type to the `HostResourceType` the embedder
   * supplied at the corresponding import path, before any initializer runs.
   *
   * Identity: all resource *tables* whose `resource` is this imported
   * ResourceIndex share the host token's dtor. `impl` stays null — an
   * imported resource is implemented by the host, not by any component
   * instance in this component, which is what the reference's
   * `ResourceType.impl` means (definitions.py `class ResourceType`).
   */
  bindImportedResources(): void {
    const imported = this.wire.importedResources ?? [];
    imported.forEach((ir, resourceIndex) => {
      const imp = this.wire.imports[ir.import];
      const label = importLabel(imp.name, imp.path);
      const value = this.lookupHostImport(imp.name, imp.path, label);
      if (!(value instanceof HostResourceType)) {
        throw new PlanError(
          `host import '${label}' must be a HostResourceType (the component ` +
            `imports a resource type); got ${describe(value)}`,
        );
      }
      const dtor = value.options.dtor;
      this.wire.resourceTables.forEach((table, tableIndex) => {
        if (table.kind !== "concrete" || table.resource !== resourceIndex) {
          return;
        }
        // A type-only import may have no concrete table at all; that is fine,
        // there is simply no runtime state to bind.
        const token = this.loaded.resourceTokens[tableIndex];
        token.impl = null;
        token.dtor = dtor === undefined ? null : (rep: number) => dtor(rep);
      });
      this.hostResourceTypes.set(resourceIndex, value);
    });
  }

  async runInitializers(): Promise<void> {
    for (const init of this.wire.initializers) {
      switch (init.op) {
        case "instantiate-module": {
          const module = this.modules[init.module];
          if (module === undefined) {
            throw new PlanError(`instantiate-module: no module ${init.module}`);
          }
          const declared = WebAssembly.Module.imports(module);
          if (declared.length !== init.args.length) {
            throw new PlanError(
              `module ${init.module}: ${declared.length} imports but ` +
                `${init.args.length} args in plan`,
            );
          }
          const importObject: WebAssembly.Imports = {};
          // Per-CORE-INSTANCE suspendability. `planNeedsSuspension` answers
          // the question for a whole component; FACT needs it for the specific
          // callee it is about to invoke, because that is what decides whether
          // the callee must be `promising`-wrapped (see `mkCalleeTask`).
          //
          // The trampoline declarations cannot answer it: `sync-start-call`
          // and `async-start-call` carry no `instance` field (verified against
          // real plans). What CAN answer it is right here -- the import list
          // of the module being instantiated. A core instance whose imports
          // include a blocking trampoline is one whose code can reach a
          // suspension point; every function it exports is therefore
          // potentially-blocking, and everything else is not.
          this.sawBlockingImport = false;
          declared.forEach((imp, i) => {
            const value = this.importValue(init.args[i]);
            (importObject[imp.module] ??=
              {} as WebAssembly.ModuleImports)[imp.name] =
                value as WebAssembly.ImportValue;
          });
          const instance = await WebAssembly.instantiate(module, importObject);
          if (this.sawBlockingImport) {
            for (const exported of Object.values(instance.exports)) {
              if (typeof exported === "function") {
                this.suspendableFuncs.add(exported as unknown as object);
              }
            }
          }
          this.instances.push(instance);
          break;
        }
        case "lower-import": {
          // Associates LoweredIndex -> RuntimeImportIndex; the callable side
          // materializes when a lower-import trampoline referencing it is
          // resolved.
          this.lowerings.set(init.index, init.import);
          break;
        }
        case "extract-memory": {
          const value = this.resolveCoreExport(init.export);
          if (!(value instanceof WebAssembly.Memory)) {
            throw new PlanError(
              `extract-memory ${init.index}: resolved to non-memory`,
            );
          }
          this.memories[init.index] = value;
          break;
        }
        case "extract-realloc": {
          this.reallocs[init.index] = this.resolveFunction(
            init.def,
            `extract-realloc ${init.index}`,
          );
          break;
        }
        case "extract-callback": {
          this.callbacks[init.index] = this.resolveFunction(
            init.def,
            `extract-callback ${init.index}`,
          );
          break;
        }
        case "extract-post-return": {
          this.postReturns[init.index] = this.resolveFunction(
            init.def,
            `extract-post-return ${init.index}`,
          );
          break;
        }
        case "extract-table": {
          const value = this.resolveCoreExport(init.export);
          if (!(value instanceof WebAssembly.Table)) {
            throw new PlanError(
              `extract-table ${init.index}: resolved to non-table`,
            );
          }
          this.tables[init.index] = value;
          break;
        }
        case "resource": {
          // Wire the dtor + implementing instance into every concrete
          // resource-table token for this defined resource
          // (tolerate-if-unreferenced for M0; plan-format.md open item).
          const dtor = init.dtor === null
            ? null
            : this.resolveFunction(init.dtor, `resource ${init.index} dtor`);
          const inst = this.componentInstance(init.instance);
          // `init.index` is a DefinedResourceIndex; resource *tables* key off
          // the component-wide ResourceIndex, which counts imported resources
          // first (plan-format.md v0.1 amendment #2 / v0.2
          // `importedResources`; wasmtime `Component::resource_index`).
          const resourceIndex = resourceIndexOfDefined(this.loaded, init.index);
          this.wire.resourceTables.forEach((table, tableIndex) => {
            if (table.kind === "concrete" && table.resource === resourceIndex) {
              const token = this.loaded.resourceTokens[tableIndex];
              token.impl = inst;
              token.dtor = dtor === null ? null : (rep: number) => {
                dtor(rep);
              };
            }
          });
          break;
        }
        default: {
          const exhaustive: never = init;
          throw new PlanError(
            `unsupported initializer op ${(exhaustive as { op: string }).op}`,
          );
        }
      }
    }
  }

  finish(): ComponentHandle {
    const exports: Record<string, unknown> = {};
    for (const exp of this.wire.exports) {
      const built = this.buildExport(exp, exp.name);
      if (built.kind === "value") exports[exp.name] = built.value;
    }
    // Structural check of jspi/bridge.ts's invariant, run once both wrapping
    // sites have had their chance: entries are wrapped while building exports
    // (just above) and imports while running `instantiate-module`. Neither
    // flag can be set by accident — only the wrapping helpers set them.
    assertModeConsistent(
      this.suspensionMode,
      this.wrappedEntries,
      this.wrappedImports,
    );
    const componentInstances: ComponentInstanceState[] = [];
    for (const [i, state] of this.componentInstances) {
      componentInstances[i] = state;
    }
    return {
      exports,
      stats: this.stats,
      componentInstances,
      coreInstances: this.instances,
      suspendableFuncs: this.suspendableFuncs,
      taskMayBlock: this.taskMayBlock,
      hostResourceTypes: this.hostResourceTypes,
      omittedExports: this.omittedExports,
    };
  }

  // -- export surface -------------------------------------------------------

  /**
   * Materialize one plan export.
   *
   * The result is an explicit discriminated union rather than
   * `unknown | undefined`: an earlier `if (built !== undefined)` filter meant
   * *any* path that happened to yield `undefined` removed the export from the
   * component's surface with no diagnostic anywhere. Only `type` exports are
   * legitimately absent from the runtime surface, and they say so with a
   * reason that is recorded on the handle (`omittedExports`); everything else
   * either produces a value or throws.
   */
  buildExport(
    exp: WireExport,
    path: string,
  ): { kind: "value"; value: unknown } | { kind: "omitted"; reason: string } {
    switch (exp.kind) {
      case "lifted-func": {
        const ft = this.funcType(exp.type, `export '${path}'`);
        const core = this.resolveFunction(exp.coreDef, `export '${path}'`);
        const opts = this.resolveOptions(exp.options);
        return {
          kind: "value",
          value: createLiftedFunction({
            name: path,
            ft,
            opts,
            core,
            stats: this.stats,
            suspensionMode: this.noteEntry(),
            trapState: this.trapState,
            syncCallStack: this.syncCallStack,
            allInstances: () => this.componentInstances.values(),
          }),
        };
      }
      case "instance": {
        const nested: Record<string, unknown> = {};
        for (const sub of exp.exports) {
          const built = this.buildExport(sub, `${path}/${sub.name}`);
          if (built.kind === "value") nested[sub.name] = built.value;
        }
        return { kind: "value", value: nested };
      }
      case "type":
        // Informational (plan-format.md): an exported *type* has no callable
        // runtime surface. Recorded, not silently dropped.
        this.omittedExports.set(
          path,
          "type export: no runtime surface (plan-format.md)",
        );
        return {
          kind: "omitted",
          reason: "type export: no runtime surface",
        };
      default: {
        const exhaustive: never = exp;
        throw new PlanError(
          `unsupported export kind ${(exhaustive as { kind: string }).kind}`,
        );
      }
    }
  }

  // -- resolution -----------------------------------------------------------

  componentInstance(index: number): ComponentInstanceState {
    let state = this.componentInstances.get(index);
    if (state === undefined) {
      state = new ComponentInstanceState(index, this.store);
      this.componentInstances.set(index, state);
    }
    return state;
  }

  /** Memoized `LiveMemory` for a `RuntimeMemoryIndex` (see `liveMemories`). */
  liveMemory(index: number): LiveMemory {
    let m = this.liveMemories.get(index);
    if (m === undefined) {
      m = new LiveMemory(() => this.memories[index], `memory ${index}`);
      this.liveMemories.set(index, m);
    }
    return m;
  }

  unsafeIntrinsic(symbol: string): CoreFn {
    let fn = this.unsafeIntrinsics.get(symbol);
    if (fn === undefined) {
      fn = createUnsafeIntrinsic(symbol);
      this.unsafeIntrinsics.set(symbol, fn);
    }
    return fn;
  }

  /**
   * Resolve a core-instantiation argument.
   *
   * Identical to `resolveCoreDef` except that in jspi mode a *blocking-capable*
   * trampoline is handed to wasm as a `WebAssembly.Suspending`, so that
   * returning a Promise from it suspends the calling activation instead of
   * trapping. Only this path wraps: the same trampoline resolved anywhere the
   * host will *call* it from JS (extract-callback, post-return, realloc) must
   * stay an ordinary function.
   */
  importValue(def: WireCoreDef): Importable {
    const value = this.resolveCoreDef(def);
    // Suspendability is TRANSITIVE. FACT does not put blocking trampolines in
    // the guest's own module: it generates an adapter module that imports
    // them, and the guest imports the adapter's exported function. So a core
    // instance is suspendable if it imports a blocking trampoline OR imports a
    // function from an already-suspendable instance. Missing this closure is
    // what made `async-calls-sync`'s sync-lifted middle look non-blocking and
    // broke the handshake pins.
    if (
      typeof value === "function" &&
      this.suspendableFuncs.has(value as unknown as object)
    ) {
      this.sawBlockingImport = true;
    }
    if (
      this.suspensionMode !== "jspi" || def.kind !== "trampoline" ||
      typeof value !== "function"
    ) {
      return value;
    }
    const kind = this.wire.trampolines[def.index]?.kind ?? "";
    if (!BLOCKING_TRAMPOLINES.has(kind)) return value;
    this.sawBlockingImport = true;
    this.noteImport();
    return suspendingImport(
      value as (...a: never[]) => unknown,
      "jspi",
    ) as unknown as Importable;
  }

  resolveCoreDef(def: WireCoreDef): Importable {
    switch (def.kind) {
      case "export": {
        return this.resolveCoreExport({
          instance: def.instance,
          item: def.item,
        });
      }
      case "instance-flags":
        return this.componentInstance(def.instance).flags;
      case "trampoline":
        return this.trampoline(def.index);
      case "unsafe-intrinsic":
        // plan v1: wasmtime compile-time builtins imported directly by a core
        // module. `context.{get,set}` become host functions over the *current
        // thread's* context slots (definitions.py `Thread.storage`); every
        // other symbol fails here, at instantiate time.
        return this.unsafeIntrinsic(def.intrinsic);
      case "task-may-block":
        return this.taskMayBlock;
      default: {
        const exhaustive: never = def;
        throw new PlanError(
          `unsupported CoreDef kind ${(exhaustive as { kind: string }).kind}`,
        );
      }
    }
  }

  resolveCoreExport(ref: WireCoreExport): Importable {
    const instance = this.instances[ref.instance];
    if (instance === undefined) {
      throw new PlanError(
        `core export ref: runtime instance ${ref.instance} not created yet`,
      );
    }
    const value = instance.exports[ref.item.name];
    if (value === undefined) {
      throw new PlanError(
        `core instance ${ref.instance} has no export '${ref.item.name}'`,
      );
    }
    return value as Importable;
  }

  resolveFunction(def: WireCoreDef, what: string): CoreFn {
    const value = this.resolveCoreDef(def);
    if (typeof value !== "function") {
      throw new PlanError(`${what}: resolved to non-function`);
    }
    return value as CoreFn;
  }

  trampoline(index: number): CoreFn {
    const cached = this.trampolineCache.get(index);
    if (cached !== undefined) return cached;
    const decl = this.wire.trampolines[index];
    if (decl === undefined) {
      throw new PlanError(`no trampoline ${index} in plan`);
    }
    const fn = createTrampoline(decl, {
      componentInstance: (i) => this.componentInstance(i),
      resourceToken: (i) => {
        const token = this.loaded.resourceTokens[i];
        if (token === undefined) {
          throw new PlanError(`no resource table ${i} in plan`);
        }
        return token;
      },
      runtimeMemory: (i) =>
        new TranscodeMemory(
          () => this.memories[i],
          `runtime memory ${i}`,
        ),
      resourceTableInstance: (i) => {
        const table = this.wire.resourceTables[i];
        if (table === undefined) {
          throw new PlanError(`no resource table ${i} in plan`);
        }
        if (table.kind !== "concrete") {
          throw new PlanError(
            `resource table ${i} is abstract (type-only) and has no runtime ` +
              `handle table`,
          );
        }
        return this.componentInstance(table.instance);
      },
      options: (i) => this.resolveOptions(i),
      resultTypes: (i) => this.resultTypes(i),
      callback: (i) => {
        const fn = this.callbacks[i];
        if (fn === undefined) {
          throw new PlanError(
            `callback ${i} accessed before its extract-callback initializer ran`,
          );
        }
        return fn;
      },
      memoryToken: (i) => this.liveMemory(i),
      streamElem: (i) => {
        if (i >= this.loaded.streamElems.length) {
          throw new PlanError(
            `stream table ${i} is not in the plan's streamTables (plan v2)`,
          );
        }
        return this.loaded.streamElems[i];
      },
      streamTableInstance: (i) =>
        this.componentInstance(this.loaded.streamTableInstances[i] ?? 0),
      futureTableInstance: (i) =>
        this.componentInstance(this.loaded.futureTableInstances[i] ?? 0),
      futureElem: (i) => {
        if (i >= this.loaded.futureElems.length) {
          throw new PlanError(
            `future table ${i} is not in the plan's futureTables (plan v2)`,
          );
        }
        return this.loaded.futureElems[i];
      },
      prepared: this.preparedCall,
      suspensionMode: this.suspensionMode,
      calleeCanBlock: (fn: unknown) => this.suspendableFuncs.has(fn as object),
      syncCallStack: this.syncCallStack,
      trapState: this.trapState,
      loweredImport: (d) => this.buildLoweredImport(d),
      stats: this.stats,
    });
    this.trampolineCache.set(index, fn);
    return fn;
  }

  buildLoweredImport(
    decl: Pick<
      Extract<WireTrampoline, { kind: "lower-import" }>,
      "lowered" | "options" | "type"
    >,
  ): CoreFn {
    const importIndex = this.lowerings.get(decl.lowered);
    if (importIndex === undefined) {
      throw new PlanError(
        `lower-import trampoline: lowering ${decl.lowered} was never ` +
          `initialized (initializer order violation)`,
      );
    }
    const imp = this.wire.imports[importIndex];
    if (imp === undefined) {
      throw new PlanError(`no import ${importIndex} in plan`);
    }
    const label = importLabel(imp.name, imp.path);
    const value = this.lookupHostImport(imp.name, imp.path, label);
    if (typeof value !== "function") {
      throw new PlanError(
        `host import '${label}' missing or not a function (got ` +
          `${describe(value)})`,
      );
    }
    const ft = this.funcType(decl.type, `import '${label}'`);
    const opts = this.resolveOptions(decl.options);
    return createLoweredImport({
      name: label,
      ft,
      opts,
      hostFn: value as (...args: unknown[]) => unknown,
      stats: this.stats,
    });
  }

  /**
   * Resolve one plan import against the host-provided import record: index by
   * the component's exact import string, then walk `path` (instance imports —
   * plan-format.md v0.1 amendment #4).
   */
  lookupHostImport(name: string, path: string[], label: string): unknown {
    if (!(name in this.hostImports)) {
      throw new PlanError(
        `host import '${label}' not provided (no key '${name}' in imports)`,
      );
    }
    let value: unknown = this.hostImports[name];
    const walked: string[] = [];
    for (const segment of path) {
      if (value === null || typeof value !== "object") {
        throw new PlanError(
          `host import '${label}': '${
            [name, ...walked].join("/")
          }' is ${describe(value)}, expected an object to read ` +
            `'${segment}' from`,
        );
      }
      value = (value as Record<string, unknown>)[segment];
      walked.push(segment);
    }
    return value;
  }

  /**
   * Element types of an interned *results tuple* — the `results` field of a
   * `task-return` trampoline (the shim interns a lifted function's result
   * list as a single tuple type, `intern_results_tuple`).
   */
  resultTypes(index: number): ValType[] {
    const entry: LoadedType | undefined = this.loaded.types[index];
    if (entry === undefined) {
      throw new PlanError(`task-return results: no type ${index}`);
    }
    if (entry.kind !== "value" || entry.type.kind !== "tuple") {
      throw new PlanError(
        `task-return results: type ${index} is not a tuple type`,
      );
    }
    return entry.type.elements;
  }

  funcType(index: number, what: string): FuncType {
    const entry: LoadedType | undefined = this.loaded.types[index];
    if (entry === undefined) throw new PlanError(`${what}: no type ${index}`);
    if (entry.kind !== "func") {
      throw new PlanError(`${what}: type ${index} is not a function type`);
    }
    return entry.funcType;
  }

  resolveOptions(index: number): ResolvedOptions {
    const wire: WireCanonicalOptions | undefined =
      this.wire.canonicalOptions[index];
    if (wire === undefined) {
      throw new PlanError(`no canonicalOptions ${index} in plan`);
    }
    const memoryIndex = wire.memory;
    return {
      stringEncoding: wire.stringEncoding,
      memory: memoryIndex === null ? null : this.liveMemory(memoryIndex),
      realloc: wire.realloc === null
        ? null
        : () => this.reallocs[wire.realloc!],
      postReturn: wire.postReturn === null
        ? null
        : () => this.postReturns[wire.postReturn!],
      callback: wire.callback === null
        ? null
        : () => this.callbacks[wire.callback!],
      async: wire.async,
      cancellable: wire.cancellable,
      coreType: wire.coreType,
      instance: this.componentInstance(wire.instance),
    };
  }
}

/** `name` plus instance path, for diagnostics: `"ns:pkg/iface"."f"`. */
function importLabel(name: string, path: string[]): string {
  return path.length === 0 ? name : `${name}/${path.join("/")}`;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") return `a ${v.constructor?.name ?? "object"}`;
  return `a ${typeof v}`;
}

/** Convenience for callers: typed view of a lifted export. */
export type LiftedFunction = (...args: ComponentValue[]) => unknown;
