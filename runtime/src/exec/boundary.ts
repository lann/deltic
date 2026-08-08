// Host-boundary wiring: lifted-export invocation (reference `canon_lift`,
// sync path) and lowered-import bodies (reference `canon_lower`, sync path),
// built on the cabi v1 interpreter (runtime/src/cabi/) driven by the plan's
// canonical options — PLAN.md §4.3 items 2 and 5, degenerate sync case.

import {
  type CanonicalOptions,
  coreFuncTypeEquals,
  CoreValueIter,
  type ComponentValue,
  type CoreFuncType,
  type CoreType,
  type CoreValue,
  type FuncType,
  flattenFunctype,
  liftFlatValues,
  LiftLowerContext,
  lowerFlatValues,
  MAX_FLAT_PARAMS,
  MAX_FLAT_RESULTS,
  type MemInst,
  type PtrType,
  trap,
  trapIf,
} from "../cabi/mod.ts";
import { AssertionError, assert_ } from "../cabi/trap.ts";
import {
  ComponentInstanceState,
  driveTaskToResolution,
  Subtask,
  Task,
  Thread,
} from "../task/mod.ts";
import { PlanError } from "../plan/loader.ts";

/** A raw core function as exposed through the JS WebAssembly API. */
// deno-lint-ignore no-explicit-any
export type CoreFn = (...args: any[]) => unknown;

/** Counters exposed for tests/diagnostics on the component handle. */
export interface ExecutionStats {
  liftedCalls: number;
  tasksResolved: number;
  postReturnsRun: number;
  loweredCalls: number;
  enterSyncCalls: number;
  exitSyncCalls: number;
}

export function newStats(): ExecutionStats {
  return {
    liftedCalls: 0,
    tasksResolved: 0,
    postReturnsRun: 0,
    loweredCalls: 0,
    enterSyncCalls: 0,
    exitSyncCalls: 0,
  };
}

/**
 * A `MemInst`-shaped view over a `WebAssembly.Memory` that never goes stale:
 * `bytes`/`view` re-derive from `memory.buffer` whenever the buffer identity
 * changes (memory.grow detaches the previous ArrayBuffer — a cached
 * Uint8Array would silently drop writes). The provider indirection also
 * covers plan-order effects: canonical options can reference a memory whose
 * `extract-memory` initializer runs later; accesses before extraction fail
 * with a PlanError.
 *
 * Structurally compatible with cabi's `MemInst` (same public surface).
 */
export class LiveMemory {
  readonly addrType: PtrType = "i32"; // memory64 components: out of M0 scope
  #provider: () => WebAssembly.Memory | undefined;
  #label: string;
  #buffer: ArrayBufferLike | null = null;
  #bytes: Uint8Array = new Uint8Array(0);
  #view: DataView = new DataView(new ArrayBuffer(0));

  constructor(provider: () => WebAssembly.Memory | undefined, label: string) {
    this.#provider = provider;
    this.#label = label;
  }

  #memory(): WebAssembly.Memory {
    const m = this.#provider();
    if (m === undefined) {
      throw new PlanError(
        `${this.#label} accessed before its extract-memory initializer ran`,
      );
    }
    return m;
  }

  #refresh(): void {
    const buffer = this.#memory().buffer;
    if (buffer !== this.#buffer) {
      this.#buffer = buffer;
      this.#bytes = new Uint8Array(buffer);
      this.#view = new DataView(buffer);
    }
  }

  get bytes(): Uint8Array {
    this.#refresh();
    return this.#bytes;
  }

  get view(): DataView {
    this.#refresh();
    return this.#view;
  }

  get length(): number {
    return this.#memory().buffer.byteLength;
  }

  ptrType(): PtrType {
    return this.addrType;
  }

  ptrSize(): 4 | 8 {
    return 4;
  }
}

// Compile-time proof that LiveMemory satisfies the MemInst surface.
const _memInstCheck: MemInst = new LiveMemory(() => undefined, "check");
void _memInstCheck;

/**
 * Canonical options resolved against executor state. `memory` is a
 * LiveMemory (or null); `realloc`/`postReturn`/`callback` resolve lazily so
 * options can be constructed before the corresponding extract initializers
 * run (wasmtime semantics: options hold indices, resolved at use).
 */
export interface ResolvedOptions {
  stringEncoding: "utf8" | "utf16" | "latin1+utf16";
  memory: LiveMemory | null;
  realloc: (() => CoreFn | undefined) | null;
  postReturn: (() => CoreFn | undefined) | null;
  callback: (() => CoreFn | undefined) | null;
  async: boolean;
  coreType: CoreFuncType;
  instance: ComponentInstanceState;
}

function require<T>(
  resolver: (() => T | undefined) | null,
  what: string,
): T | null {
  if (resolver === null) return null;
  const v = resolver();
  if (v === undefined) {
    throw new PlanError(`${what} accessed before its extract initializer ran`);
  }
  return v;
}

/** cabi-facing options object (LiftLowerOptions + flatten inputs). */
function cabiOptions(opts: ResolvedOptions): CanonicalOptions {
  return {
    stringEncoding: opts.stringEncoding,
    memory: opts.memory,
    realloc: opts.realloc === null ? null : (o, os, a, n) => {
      const realloc = require(opts.realloc, "realloc")!;
      const p = callCore(realloc, [o, os, a, n]);
      trapIf(p.length !== 1 || typeof p[0] !== "number", "realloc result");
      return (p[0] as number) >>> 0;
    },
    postReturn: null, // post-return handled by the task layer, not cabi
    async_: opts.async,
    callback: null,
  };
}

/**
 * Call a core function, mapping core-wasm exceptions to canonical-ABI traps
 * (reference `call_and_trap_on_throw`). Component traps and internal errors
 * of ours propagate unchanged.
 */
export function callCore(fn: CoreFn, args: CoreValue[]): CoreValue[] {
  let raw: unknown;
  try {
    raw = fn(...args);
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      trap(`guest trapped: ${e.message}`);
    }
    throw e;
  }
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw as CoreValue[];
  return [raw as CoreValue];
}

/**
 * Normalize raw JS-API core values to cabi's canonical lane representation:
 * i32 lanes as unsigned numbers (the JS API yields signed), i64 lanes as
 * unsigned bigints, floats as numbers.
 */
export function normalizeCoreValues(
  values: CoreValue[],
  lanes: CoreType[],
  what: string,
): CoreValue[] {
  if (values.length !== lanes.length) {
    throw new AssertionError(
      `${what}: expected ${lanes.length} core values, got ${values.length}`,
    );
  }
  return values.map((v, i) => {
    switch (lanes[i]) {
      case "i32":
        assert_(typeof v === "number", `${what}[${i}]: i32 lane`);
        return (v as number) >>> 0;
      case "i64":
        assert_(typeof v === "bigint", `${what}[${i}]: i64 lane`);
        return BigInt.asUintN(64, v as bigint);
      case "f32":
      case "f64":
        assert_(typeof v === "number", `${what}[${i}]: float lane`);
        return v;
    }
  });
}

/** Map a resolved result list to the host-facing return value by arity. */
function resultsToHost(results: ComponentValue[]): unknown {
  if (results.length === 0) return undefined;
  if (results.length === 1) return results[0];
  return results;
}

/**
 * Build the host-callable function for one lifted export (reference
 * `Store.lift` + `canon_lift`, sync path). Every call runs through the task
 * model: reentrance gate, Task + implicit Thread, sync driving loop,
 * post-return after result copy-out.
 */
export function createLiftedFunction(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  core: CoreFn;
  stats: ExecutionStats;
}): (...args: ComponentValue[]) => unknown {
  const { name, ft, opts, core, stats } = input;
  const inst = opts.instance;

  if (ft.async) {
    throw new PlanError(
      `export '${name}' is an async-typed function — M2 task scheduler ` +
        `(not implemented in the M0 executor)`,
    );
  }
  if (opts.async || opts.callback !== null) {
    throw new PlanError(
      `export '${name}' uses async canonical options — M2 task scheduler ` +
        `(not implemented in the M0 executor)`,
    );
  }

  // Instantiate-time consistency check (descriptor-ir.md "Flattening"):
  // flattening computed from the type must agree with the shim's coreType.
  const computed = flattenFunctype(cabiOptions(opts), ft, "lift");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(
      `export '${name}': computed flat type ${JSON.stringify(computed)} ` +
        `!= plan coreType ${JSON.stringify(opts.coreType)}`,
    );
  }

  return (...hostArgs: ComponentValue[]): unknown => {
    if (hostArgs.length !== ft.params.length) {
      throw new TypeError(
        `${name}: expected ${ft.params.length} argument(s), got ${hostArgs.length}`,
      );
    }
    stats.liftedCalls++;

    // Reference Store.lift: trap_if(!may_enter); enter_from; ...; leave_to.
    trapIf(
      !inst.mayEnter,
      `cannot enter component instance ${inst.index} (reentrance forbidden)`,
    );
    inst.enter();
    try {
      let resolved: ComponentValue[] | null = null;
      const task = new Task(
        ft,
        inst,
        () => hostArgs,
        (result) => {
          resolved = result;
        },
      );
      const thread: Thread = new Thread(task, () => {
        if (!task.enterImplicitThread(thread)) return;
        const cx = new LiftLowerContext(cabiOptions(opts), inst, task);
        const args = task.start();
        const flatArgs = lowerFlatValues(
          cx,
          MAX_FLAT_PARAMS,
          args,
          ft.params,
        );
        const flatResults = normalizeCoreValues(
          callCore(core, flatArgs),
          opts.coreType.results,
          `${name} results`,
        );
        const results = liftFlatValues(
          cx,
          MAX_FLAT_RESULTS,
          new CoreValueIter(flatResults),
          ft.results,
        );
        task.return_(results);
        stats.tasksResolved++;
        // Post-return runs after the results were read out of guest memory,
        // with may_leave cleared (reference canon_lift).
        const postReturn = require(opts.postReturn, `${name} post-return`);
        if (postReturn !== null) {
          assert_(inst.mayLeave, "post-return with may_leave already false");
          inst.mayLeave = false;
          callCore(postReturn, flatResults);
          inst.mayLeave = true;
          stats.postReturnsRun++;
        }
        task.exitImplicitThread(thread);
      });
      driveTaskToResolution(task, thread);
      assert_(resolved !== null, "task resolved without results");
      return resultsToHost(resolved!);
    } finally {
      inst.leave();
    }
  };
}

/**
 * Build the core-callable body for one lowered host import (reference
 * `canon_lower`, sync path, degenerate Subtask). The host function runs
 * synchronously; borrows lifted for the call are released at resolve
 * delivery.
 */
export function createLoweredImport(input: {
  name: string;
  ft: FuncType;
  opts: ResolvedOptions;
  hostFn: (...args: unknown[]) => unknown;
  stats: ExecutionStats;
}): CoreFn {
  const { name, ft, opts, hostFn, stats } = input;
  const inst = opts.instance;

  if (ft.async || opts.async) {
    throw new PlanError(
      `import '${name}' uses the async ABI — M2 task scheduler ` +
        `(not implemented in the M0 executor)`,
    );
  }
  const computed = flattenFunctype(cabiOptions(opts), ft, "lower");
  if (!coreFuncTypeEquals(computed, opts.coreType)) {
    throw new PlanError(
      `import '${name}': computed flat type ${JSON.stringify(computed)} ` +
        `!= plan coreType ${JSON.stringify(opts.coreType)}`,
    );
  }

  return (...rawFlatArgs: CoreValue[]): unknown => {
    stats.loweredCalls++;
    // Reference canon_lower: trap_if(!inst.may_leave).
    trapIf(
      !inst.mayLeave,
      `cannot leave component instance ${inst.index} (may_leave violation)`,
    );
    const subtask = new Subtask();
    const cx = new LiftLowerContext(cabiOptions(opts), inst, subtask);
    const vi = new CoreValueIter(
      normalizeCoreValues(rawFlatArgs, opts.coreType.params, `${name} args`),
    );
    subtask.onStart();
    const args = liftFlatValues(cx, MAX_FLAT_PARAMS, vi, ft.params);
    const hostResult = hostFn(...args);
    const results: ComponentValue[] = ft.results.length === 0
      ? []
      : [hostResult as ComponentValue];
    subtask.onReturn();
    // Spilled results use the trailing retptr lane(s) of the flat args
    // (reference passes the same iterator as out_param).
    const flatResults = lowerFlatValues(
      cx,
      MAX_FLAT_RESULTS,
      results,
      ft.results,
      vi,
    );
    subtask.deliverResolve();
    assert_(vi.done(), `${name}: unconsumed flat arguments`);
    if (flatResults.length === 0) return undefined;
    if (flatResults.length === 1) return flatResults[0];
    return flatResults;
  };
}
