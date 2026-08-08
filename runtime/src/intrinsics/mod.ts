// Host trampolines (contracts/intrinsics.md §B) and FACT-adapter intrinsic
// obligations (§A) — the M0 subset, with instantiate-time (never call-time)
// milestone-aware failures for everything else.
//
// Implemented in M0:
//   lower-import        host function call through descriptor-IR lift/lower
//   trap                FACT `Trap` import -> ComponentTrap
//   enter/exit-sync-call  degenerate sync-call bookkeeping (assert-and-count)
//   resource-new/rep/drop  sync resource paths over cabi handle tables
//                          (M1 schedule, implemented early: the resources
//                          fixture references them at instantiation)
//
// Everything else fails at instantiate time with the milestone at which
// intrinsics.md §B schedules it — "this component needs the M2 task core"
// is a feature, not a crash.

import {
  canonResourceDrop,
  canonResourceNew,
  canonResourceRep,
  trap,
} from "../cabi/mod.ts";
import { assert_ } from "../cabi/trap.ts";
import type { ResourceTypeInfo } from "../cabi/types.ts";
import type { ComponentInstanceState } from "../task/mod.ts";
import type { WireTrampoline } from "../plan/format.ts";
import type { CoreFn, ExecutionStats } from "../exec/boundary.ts";

/** Instantiate-time failure for functionality scheduled after M0. */
export class UnsupportedFeatureError extends Error {
  constructor(public milestone: "M1" | "M2", what: string) {
    super(
      `${what} — scheduled for ${milestone}, not implemented in the M0 ` +
        `executor (contracts/intrinsics.md §B)`,
    );
    this.name = "UnsupportedFeatureError";
  }
}

/** Milestone at which each trampoline kind stops instantiate-failing. */
const TRAMPOLINE_MILESTONE: Record<string, "M0" | "M1" | "M2"> = {
  "lower-import": "M0",
  "trap": "M0",
  "enter-sync-call": "M0",
  "exit-sync-call": "M0",
  "resource-new": "M1",
  "resource-rep": "M1",
  "resource-drop": "M1",
  "transcoder": "M1",
};

function milestoneOf(kind: string): "M0" | "M1" | "M2" {
  return TRAMPOLINE_MILESTONE[kind] ?? "M2";
}

/** Executor services a trampoline body needs (provided by executor.ts). */
export interface TrampolineContext {
  componentInstance(index: number): ComponentInstanceState;
  resourceToken(index: number): ResourceTypeInfo;
  /** Build the lowered-import body for `lowered` (LoweredIndex). */
  loweredImport(decl: {
    lowered: number;
    options: number;
    type: number;
  }): CoreFn;
  stats: ExecutionStats;
}

/** Shared field shape of resource-new/rep/drop declarations. */
interface ResourceTrampolineDecl {
  instance: number;
  resource: number;
}

/**
 * Create the JS function backing one plan trampoline. Called during
 * initializer/arg/export resolution — i.e. at instantiate time — so an
 * unsupported kind fails instantiation, not the first call
 * (plan-format.md "Executor obligations"). Unreferenced trampolines are
 * never created and therefore never fail (intrinsics.md §B tolerates e.g.
 * an unreferenced task-return until M2).
 */
export function createTrampoline(
  decl: WireTrampoline,
  ctx: TrampolineContext,
): CoreFn {
  switch (decl.kind) {
    case "lower-import": {
      const d = decl as Extract<WireTrampoline, { kind: "lower-import" }>;
      return ctx.loweredImport(d);
    }

    case "trap":
      // FACT `Trap` import: (code: i32) -> never. The code enumerates FACT
      // trap causes; v0 maps them all to a ComponentTrap.
      return (code?: number) => {
        trap(`FACT adapter trap (code ${code ?? "?"})`);
      };

    // Sync-call task bookkeeping (intrinsics.md §A: "degenerate-case
    // implementation in M0: assert-and-count"). wasmtime 47 signatures:
    // enter-sync-call/exit-sync-call take no wasm-visible arguments that we
    // act on in M0; balance is asserted at component teardown by tests.
    case "enter-sync-call":
      return (..._args: unknown[]) => {
        ctx.stats.enterSyncCalls++;
      };
    case "exit-sync-call":
      return (..._args: unknown[]) => {
        ctx.stats.exitSyncCalls++;
        assert_(
          ctx.stats.exitSyncCalls <= ctx.stats.enterSyncCalls,
          "exit-sync-call without matching enter-sync-call",
        );
      };

    // Guest-side resource built-ins (sync paths of PLAN.md §7 over the cabi
    // handle tables). rep is always i32 in current wasmtime.
    case "resource-new": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (rep: number) => canonResourceNew(inst, rt, rep >>> 0);
    }
    case "resource-rep": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (handle: number) => canonResourceRep(inst, rt, handle >>> 0);
    }
    case "resource-drop": {
      const d = decl as unknown as ResourceTrampolineDecl;
      const inst = ctx.componentInstance(d.instance);
      const rt = ctx.resourceToken(d.resource);
      return (handle: number) => {
        canonResourceDrop(inst, rt, handle >>> 0);
      };
    }

    default:
      throw new UnsupportedFeatureError(
        milestoneOf(decl.kind) === "M1" ? "M1" : "M2",
        `component requires host trampoline '${decl.kind}'`,
      );
  }
}
