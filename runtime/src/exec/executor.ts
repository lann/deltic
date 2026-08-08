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

import type { ComponentValue, FuncType } from "../cabi/types.ts";
import { ComponentInstanceState } from "../task/mod.ts";
import {
  loadPlan,
  PlanError,
} from "../plan/loader.ts";
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
import { createTrampoline } from "../intrinsics/mod.ts";

/** Host-provided imports, keyed by the component's import name, with nested
 * records for instance imports (walked by `plan.imports[].path`). */
export type HostImports = Record<string, unknown>;

export interface InstantiateInput {
  plan: WirePlan;
  /** The original component binary (embedded modules are sliced from it). */
  componentBytes: Uint8Array;
  /** FACT adapter artifacts keyed by `plan.modules[].file`. */
  adapters?: Map<string, Uint8Array>;
  imports?: HostImports;
  /** Verify plan.component.sha256 against componentBytes (default true). */
  verifyHash?: boolean;
}

/** An instantiated component: its export surface plus introspection state. */
export interface ComponentHandle {
  /** Lifted functions / nested instance objects, by export name. */
  exports: Record<string, unknown>;
  stats: ExecutionStats;
  componentInstances: ComponentInstanceState[];
  coreInstances: WebAssembly.Instance[];
  taskMayBlock: WebAssembly.Global;
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
  await executor.runInitializers();
  return executor.finish();
}

type Importable =
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

  readonly stats: ExecutionStats = newStats();
  readonly modules: WebAssembly.Module[] = [];
  readonly instances: WebAssembly.Instance[] = [];
  readonly componentInstances = new Map<number, ComponentInstanceState>();
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

  constructor(loaded: LoadedPlan, input: InstantiateInput) {
    this.loaded = loaded;
    this.wire = loaded.wire;
    this.componentBytes = input.componentBytes;
    this.adapterBytes = input.adapters ?? new Map();
    this.hostImports = input.imports ?? {};
    this.verifyHash = input.verifyHash ?? true;
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
          declared.forEach((imp, i) => {
            const value = this.resolveCoreDef(init.args[i]);
            (importObject[imp.module] ??=
              {} as WebAssembly.ModuleImports)[imp.name] =
                value as WebAssembly.ImportValue;
          });
          const instance = await WebAssembly.instantiate(module, importObject);
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
          // M0 restriction: without imported-resource metadata in the plan,
          // ResourceIndex == DefinedResourceIndex only when nothing imports
          // resources.
          if (this.wire.imports.some((imp) => imp.kind === "resource")) {
            throw new PlanError(
              "imported resources are not supported by the M0 executor " +
                "(ResourceIndex mapping undefined in plan v0)",
            );
          }
          this.wire.resourceTables.forEach((table, tableIndex) => {
            if (table.kind === "concrete" && table.resource === init.index) {
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
      const built = this.buildExport(exp);
      if (built !== undefined) exports[exp.name] = built;
    }
    const componentInstances: ComponentInstanceState[] = [];
    for (const [i, state] of this.componentInstances) {
      componentInstances[i] = state;
    }
    return {
      exports,
      stats: this.stats,
      componentInstances,
      coreInstances: this.instances,
      taskMayBlock: this.taskMayBlock,
    };
  }

  // -- export surface -------------------------------------------------------

  buildExport(exp: WireExport): unknown {
    switch (exp.kind) {
      case "lifted-func": {
        const ft = this.funcType(exp.type, `export '${exp.name}'`);
        const core = this.resolveFunction(exp.coreDef, `export '${exp.name}'`);
        const opts = this.resolveOptions(exp.options);
        return createLiftedFunction({
          name: exp.name,
          ft,
          opts,
          core,
          stats: this.stats,
        });
      }
      case "instance": {
        const nested: Record<string, unknown> = {};
        for (const sub of exp.exports) {
          const built = this.buildExport(sub);
          if (built !== undefined) nested[sub.name] = built;
        }
        return nested;
      }
      case "type":
        // Informational (plan-format.md); no runtime surface in M0.
        return undefined;
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
      state = new ComponentInstanceState(index);
      this.componentInstances.set(index, state);
    }
    return state;
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
    return value;
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
    const label = [imp.name, ...imp.path].join(".");
    let value: unknown = this.hostImports[imp.name];
    for (const segment of imp.path) {
      if (value === null || typeof value !== "object") {
        throw new PlanError(
          `host import '${label}': missing intermediate object at ` +
            `'${segment}'`,
        );
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (typeof value !== "function") {
      throw new PlanError(`host import '${label}' missing or not a function`);
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
      memory: memoryIndex === null ? null : new LiveMemory(
        () => this.memories[memoryIndex],
        `memory ${memoryIndex}`,
      ),
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
      coreType: wire.coreType,
      instance: this.componentInstance(wire.instance),
    };
  }
}

/** Convenience for callers: typed view of a lifted export. */
export type LiftedFunction = (...args: ComponentValue[]) => unknown;
