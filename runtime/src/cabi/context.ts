// Canonical options and lift/lower context (definitions.py `## Canonical ABI
// Options`, `## Lifting and Lowering Context`).

import { assert_, trapIf } from "./trap.ts";
import type { MemInst } from "./memory.ts";
import type { StringEncoding } from "./types.ts";
import type { Table } from "./handles.ts";

/**
 * definitions.py realloc signature: (original_ptr, original_size, alignment,
 * new_size) -> ptr. Addresses as JS numbers (see memory.ts).
 */
export type ReallocFn = (
  originalPtr: number,
  originalSize: number,
  alignment: number,
  newSize: number,
) => number;

export interface LiftOptions {
  stringEncoding: StringEncoding;
  memory: MemInst | null;
}

export interface LiftLowerOptions extends LiftOptions {
  realloc: ReallocFn | null;
}

export interface CanonicalOptions extends LiftLowerOptions {
  postReturn: (() => void) | null;
  async_: boolean;
  callback: unknown | null;
}

export function mkCanonicalOptions(
  partial: Partial<CanonicalOptions> = {},
): CanonicalOptions {
  return {
    stringEncoding: partial.stringEncoding ?? "utf8",
    memory: partial.memory ?? null,
    realloc: partial.realloc ?? null,
    postReturn: partial.postReturn ?? null,
    async_: partial.async_ ?? false,
    callback: partial.callback ?? null,
  };
}

/** Memory accessor that traps-or-asserts like `cx.opts.memory` derefs. */
export function requireMemory(opts: LiftOptions): MemInst {
  assert_(opts.memory !== null, "canonical option `memory` required");
  return opts.memory;
}

/**
 * Minimal component-instance stand-in for the value interpreter: a handle
 * table plus the `may_leave` gate. The full ComponentInstance (may_enter,
 * backpressure, threads, ...) belongs to the deferred task machinery.
 */
export interface ComponentInstanceLike {
  handles: Table<unknown>;
  mayLeave: boolean;
}

/**
 * Borrow scopes (definitions.py `LiftLowerContext.borrow_scope`):
 * - lifting a borrow requires the *subtask* side: `add_lender`.
 * - lowering a borrow requires the *task* side: `num_borrows`.
 * The real Task/Subtask classes are deferred; these are the minimal
 * interfaces the value code needs.
 */
export interface SubtaskBorrowScope {
  addLender(h: import("./handles.ts").ResourceHandle): void;
}

export interface TaskBorrowScope {
  numBorrows: number;
}

export class LiftLowerContext {
  constructor(
    public opts: LiftLowerOptions,
    public inst: ComponentInstanceLike | null = null,
    public borrowScope: SubtaskBorrowScope | TaskBorrowScope | null = null,
  ) {}

  /**
   * definitions.py `LiftLowerContext.reallocate` routes the call through
   * canon_lift (reentrance bookkeeping and may_leave toggling around a
   * guest-side realloc export). v1 simplification: call the provided realloc
   * directly. The full path returns with the task machinery.
   */
  reallocate(
    old: number,
    oldByteLength: number,
    alignment: number,
    newByteLength: number,
  ): number {
    const realloc = this.opts.realloc;
    trapIf(realloc === null, "realloc required but not provided");
    return realloc!(old, oldByteLength, alignment, newByteLength);
  }

  allocate(alignment: number, byteLength: number): number {
    return this.reallocate(0, 0, alignment, byteLength);
  }
}
