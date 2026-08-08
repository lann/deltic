// The 0.3 task model (PLAN.md §6): `ComponentInstance`, `Task`, and the
// re-export surface of the task core. Thread, Waitable/WaitableSet, Subtask
// and the scheduler live in sibling modules; see ./scheduler.ts for the
// scheduling-policy rationale and the generator-based thread model.
//
// Structural correspondence to definitions.py is the design constraint here:
// where this file diverges, the divergence is called out in a comment with
// the reference's line number. The two systematic divergences are
//
//   1. threads are generators, not OS threads (./scheduler.ts header), and
//   2. the shared-everything-threads built-ins (`thread.suspend-then-resume`
//      and friends, 🧵) are absent rather than approximated — PLAN.md §16
//      defers that feature with memory64.

import { Table } from "../cabi/handles.ts";
import type { ComponentInstanceLike } from "../cabi/context.ts";
import type { ComponentValue, FuncType } from "../cabi/types.ts";
import { assert_, trapIf } from "../cabi/trap.ts";
import {
  type Cancelled,
  CANCELLED_TRUE,
  chooseCandidate,
  Store,
} from "./scheduler.ts";
import { Thread } from "./thread.ts";
import { Waitable, WaitableSet } from "./waitable.ts";
import { Subtask } from "./subtask.ts";

export * from "./scheduler.ts";
export * from "./thread.ts";
export * from "./waitable.ts";
export * from "./subtask.ts";
export * from "./streams.ts";

/** Anything a component instance's handle table can hold. */
export type HandleTableEntry = unknown;

/**
 * Per-component-instance runtime state (definitions.py `ComponentInstance`,
 * line 191).
 *
 * `mayLeave` is backed by a real `WebAssembly.Global(i32, mutable)` because
 * FACT adapters import that global (`flags` namespace) and read/write it as
 * the may_leave boolean (wasmtime 47 FACT treats the whole flags global as
 * may_leave; there is no bitmask). Initial value 1 (true). `mayEnter` is
 * host-side state: nothing wasm-visible reads it.
 */
export class ComponentInstanceState implements ComponentInstanceLike {
  readonly index: number;
  readonly flags: WebAssembly.Global;
  handles: Table<HandleTableEntry> = new Table();
  /** definitions.py `ComponentInstance.threads` — a Table, so `thread.index`. */
  readonly threads: Table<Thread> = new Table();
  mayEnter = true;
  /** definitions.py `backpressure: int` — a *counter* (backpressure.{inc,dec}). */
  backpressure = 0;
  /** definitions.py `num_waiting_to_enter`. */
  numWaitingToEnter = 0;
  /** definitions.py `exclusive_thread`. */
  exclusiveThread: Thread | null = null;
  /**
   * definitions.py `ComponentInstance.parent`. The plan gives us a flat
   * instance space with no nesting information, so this stays null and
   * `selfAndAncestors` degenerates to `{this}` — see `enteringSet`.
   */
  parent: ComponentInstanceState | null = null;
  readonly store: Store;

  constructor(index: number, store?: Store) {
    this.index = index;
    this.store = store ?? new Store();
    this.flags = new WebAssembly.Global({ value: "i32", mutable: true }, 1);
  }

  get mayLeave(): boolean {
    return (this.flags.value as number) !== 0;
  }

  set mayLeave(v: boolean) {
    this.flags.value = v ? 1 : 0;
  }

  /** definitions.py `ComponentInstance.self_and_ancestors` (line 236). */
  selfAndAncestors(): Set<ComponentInstanceState> {
    const s = new Set<ComponentInstanceState>([this]);
    let a = this.parent;
    while (a !== null) {
      s.add(a);
      a = a.parent;
    }
    return s;
  }

  /**
   * definitions.py `ComponentInstance.entering_set` (line 230):
   * `self_and_ancestors() - caller.self_and_ancestors()`.
   *
   * CONTRACT / KNOWN UNSOUNDNESS: contracts/plan-format.md gives no wire form
   * for the component *instance tree* (`ComponentInstance.parent`), so every
   * instance here is its own root. With no ancestors, the entering set is
   * `{this}` when the caller is a different instance (or the host) and `{}`
   * when the caller is this instance itself.
   *
   * For a **flat** component this is exact. For a **nested** one it is not
   * merely weaker — it admits reentrance the reference forbids. In the
   * reference, entering a child locks the child *and every ancestor it was
   * reached through*, so a callee cannot call back into an enclosing
   * component that is mid-execution. Here the ancestor is never locked, so
   * that call is permitted and a component can observe itself re-entered —
   * precisely the state `may_enter` exists to make unreachable. It is not a
   * missing optimization; it is a hole in the reentrance gate whose size is
   * "however deep the instance tree is".
   *
   * Nothing in the current corpus exercises it (the sync suite is flat and
   * the async suite is blocked earlier), which is why it is recorded rather
   * than worked around: a faithful fix needs the nesting information in the
   * plan, not a guess in the runtime. Recorded as v0.3 contract friction and
   * as the blocker for `test_cross_component_realloc`.
   */
  enteringSet(caller: ComponentInstanceState | null): Set<ComponentInstanceState> {
    const mine = this.selfAndAncestors();
    if (caller === null) return mine;
    for (const c of caller.selfAndAncestors()) mine.delete(c);
    return mine;
  }

  /** definitions.py `ComponentInstance.may_enter_from` (line 214). */
  mayEnterFrom(caller: ComponentInstanceState | null): boolean {
    for (const inst of this.enteringSet(caller)) {
      if (!inst.mayEnter) return false;
    }
    return true;
  }

  /** definitions.py `ComponentInstance.enter_from` (line 220). */
  enterFrom(caller: ComponentInstanceState | null): void {
    for (const inst of this.enteringSet(caller)) {
      assert_(inst.mayEnter, "enter_from without may_enter");
      inst.mayEnter = false;
    }
  }

  /** definitions.py `ComponentInstance.leave_to` (line 225). */
  leaveTo(caller: ComponentInstanceState | null): void {
    for (const inst of this.enteringSet(caller)) {
      assert_(!inst.mayEnter, "leave_to without a matching enter_from");
      inst.mayEnter = true;
    }
  }

  /** Backwards-compatible host-entry helpers (the M0 spelling). */
  enter(): void {
    this.enterFrom(null);
  }

  leave(): void {
    this.leaveTo(null);
  }
}

/** definitions.py `Task.State` (line 445). */
export type TaskState =
  | "initial"
  | "started"
  | "pending-cancel"
  | "cancel-delivered"
  | "resolved";

export type OnStart = () => ComponentValue[];
export type OnResolve = (result: ComponentValue[] | null) => void;

/**
 * Canonical options as the task model needs to see them (definitions.py
 * `Task.opts`): only the two flags that change task *semantics*.
 */
export interface TaskOptions {
  async_: boolean;
  callback: boolean;
  /**
   * The two fields definitions.py's `LiftOptions.equal` (line 643) compares.
   * `canon_task_return` requires the options at the `task.return` site to
   * equal the ones the task was lifted with, so the task has to remember
   * them.
   */
  stringEncoding: string;
  memory: unknown | null;
}

/** definitions.py `LiftOptions.equal` (line 643): encoding + memory identity. */
export function liftOptionsEqual(
  a: { stringEncoding: string; memory: unknown | null },
  b: { stringEncoding: string; memory: unknown | null },
): boolean {
  return a.stringEncoding === b.stringEncoding && a.memory === b.memory;
}

/**
 * One export activation (definitions.py `class Task`, line 444). Also the
 * task-side borrow scope: `numBorrows` satisfies cabi's `TaskBorrowScope`.
 */
export class Task {
  state: TaskState = "initial";
  /** TaskBorrowScope (cabi/context.ts): live borrows lowered into this task. */
  numBorrows = 0;
  implicitThread: Thread | null = null;
  readonly threads: Thread[] = [];
  /**
   * True for a task created by a FACT cross-component call
   * (`prepare-call`, see intrinsics/fact_calls.ts).
   *
   * Such a task's `onStart` / `onResolve` carry **flat core values**, not
   * lifted component values: FACT fuses the caller-side lift and callee-side
   * lower into a pair of adapter functions (`[async-start]` / `[async-return]`)
   * that run *in wasm*, so the host only shuttles the core values between
   * them. definitions.py has no analogue because it has no fused adapters —
   * there, `canon_lift` lowers the params and `canon_lower`'s `on_resolve`
   * lifts the results, both in the host. The observable semantics are
   * identical; only which side of the boundary performs the copy differs.
   *
   * `canon_task_return` consults this to decide whether to lift its flat
   * arguments (host-boundary task) or pass them straight through (FACT task).
   */
  factPassthrough = false;

  constructor(
    public ft: FuncType,
    public opts: TaskOptions,
    public inst: ComponentInstanceState,
    public onStart: OnStart,
    public onResolve: OnResolve,
  ) {}

  /**
   * definitions.py `Task.needs_exclusive` (line 473): an async-typed task
   * needs the instance's exclusive thread unless it is a *stackful* async
   * lift. Sync-lowered (`not opts.async_`) and callback-ABI tasks both do.
   */
  needsExclusive(): boolean {
    assert_(this.ft.async === true, "needs_exclusive on a sync-typed task");
    return !this.opts.async_ || this.opts.callback;
  }

  /**
   * definitions.py `Task.enter_implicit_thread` (line 477) — the backpressure
   * and exclusivity gate, in full.
   *
   * Returns false when the task was cancelled while waiting to enter, in
   * which case the caller must return immediately (the task is already
   * resolved by `cancel()`).
   */
  *enterImplicitThread(
    thread: Thread,
  ): Generator<import("./scheduler.ts").BlockRequest, boolean, Cancelled> {
    assert_(this.state === "initial", "enter_implicit_thread after start");
    this.implicitThread = thread;
    if (this.ft.async === true) {
      const hasBackpressure = (): boolean =>
        this.inst.backpressure > 0 ||
        (this.needsExclusive() && this.inst.exclusiveThread !== null);
      // The `num_waiting_to_enter > 0` disjunct is what makes entry a queue
      // rather than a stampede: once anyone is waiting, later arrivals wait
      // too, even if backpressure has since cleared.
      if (hasBackpressure() || this.inst.numWaitingToEnter > 0) {
        this.inst.numWaitingToEnter += 1;
        let cancelled: Cancelled;
        try {
          cancelled = yield* thread.waitUntil(() => !hasBackpressure(), true);
        } finally {
          this.inst.numWaitingToEnter -= 1;
        }
        if (cancelled) {
          this.cancel();
          return false;
        }
      }
      if (this.needsExclusive()) {
        assert_(
          this.inst.exclusiveThread === null,
          "entering with the exclusive thread already taken",
        );
        this.inst.exclusiveThread = thread;
      }
    }
    this.registerThread(thread);
    return true;
  }

  /** definitions.py `Task.register_thread` (line 497). */
  registerThread(thread: Thread): void {
    assert_(
      !this.threads.includes(thread) && thread.task === this,
      "register_thread of a foreign or duplicate thread",
    );
    this.threads.push(thread);
    assert_(thread.index === null, "register_thread of an indexed thread");
    thread.index = this.inst.threads.add(thread);
  }

  /** definitions.py `Task.exit_implicit_thread` (line 503). */
  exitImplicitThread(thread: Thread): void {
    assert_(thread === this.implicitThread, "exit of a non-implicit thread");
    this.unregisterThread(thread);
    if (this.ft.async === true && this.needsExclusive()) {
      assert_(
        this.inst.exclusiveThread === thread,
        "exit_implicit_thread without holding the exclusive thread",
      );
      this.inst.exclusiveThread = null;
    }
  }

  /** definitions.py `Task.unregister_thread` (line 510). */
  unregisterThread(thread: Thread): void {
    const i = this.threads.indexOf(thread);
    assert_(i !== -1 && thread.task === this, "unregister of a foreign thread");
    this.threads.splice(i, 1);
    if (this.threads.length === 0) {
      trapIf(
        this.state !== "resolved",
        "task finished all threads without resolving",
      );
      assert_(this.numBorrows === 0, "task exited with live borrows");
    }
    assert_(thread.index !== null, "unregister of an unindexed thread");
    this.inst.threads.remove(thread.index);
    thread.index = null;
  }

  /**
   * definitions.py `Task.request_cancellation` (line 519). Delivered to a
   * cancellable thread if one exists and the instance is enterable; otherwise
   * recorded as pending, to be picked up at the next cancellable block point
   * (`deliverPendingCancel`).
   */
  requestCancellation(caller: ComponentInstanceState | null): void {
    if (this.state === "initial") {
      this.state = "cancel-delivered";
      this.implicitThread!.resume(CANCELLED_TRUE);
      return;
    }
    assert_(
      this.state === "started",
      `request_cancellation in state ${this.state}`,
    );
    let candidates = this.threads.filter((t) => t.cancellable);
    if (
      this.ft.async === true && this.needsExclusive() &&
      this.inst.exclusiveThread !== null &&
      this.inst.exclusiveThread !== this.implicitThread
    ) {
      candidates = candidates.filter((t) => t !== this.implicitThread);
    }
    if (candidates.length > 0 && this.inst.mayEnterFrom(caller)) {
      this.state = "cancel-delivered";
      this.inst.enterFrom(caller);
      try {
        chooseCandidate(candidates).resume(CANCELLED_TRUE);
      } finally {
        this.inst.leaveTo(caller);
      }
    } else {
      this.state = "pending-cancel";
    }
  }

  /** definitions.py `Task.deliver_pending_cancel` (line 536). */
  deliverPendingCancel(cancellable: boolean): boolean {
    if (cancellable && this.state === "pending-cancel") {
      this.state = "cancel-delivered";
      return true;
    }
    return false;
  }

  /** definitions.py `Task.start` (line 542). */
  start(): ComponentValue[] {
    assert_(this.state === "initial", "start on a started task");
    this.state = "started";
    return this.onStart();
  }

  /** definitions.py `Task.return_` (line 547). */
  return_(result: ComponentValue[]): void {
    trapIf(this.state === "resolved", "task.return on a resolved task");
    trapIf(this.numBorrows > 0, "task returned with live borrows");
    this.onResolve(result);
    this.state = "resolved";
  }

  /** definitions.py `Task.cancel` (line 554). */
  cancel(): void {
    trapIf(
      this.state !== "cancel-delivered",
      "task.cancel without a delivered cancellation request",
    );
    trapIf(this.numBorrows > 0, "task cancelled with live borrows");
    this.onResolve(null);
    this.state = "resolved";
  }
}

/** Convenience re-exports so `../task/mod.ts` remains the single entry point. */
export { Store, Subtask, Thread, Waitable, WaitableSet };
