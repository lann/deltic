// Task-model skeleton (PLAN.md §6): Task / Thread / Subtask and the
// component-instance state (reentrance gates, handle table), mirroring the
// structures of definitions.py (`class Task`, `class Thread`,
// `class Subtask`, `class ComponentInstance`).
//
// M0 implements the **degenerate sync path**: every lifted-export call
// creates a Task whose implicit Thread runs to completion synchronously; the
// sync driving loop (`driveTaskToResolution`) pumps ready threads until the
// task resolves and traps on deadlock, exactly as the reference's
// `canon_lift` driving loop. Suspension (`waitUntil`), backpressure waiting,
// the callback protocol and cancellation are M2 — they throw
// `NotImplemented` here rather than being absent, so the structure is the
// spine the M2 scheduler grows into, not a bypass.

import { Table } from "../cabi/handles.ts";
import type { ComponentInstanceLike } from "../cabi/context.ts";
import type { ComponentValue, FuncType } from "../cabi/types.ts";
import { assert_, NotImplemented, trapIf } from "../cabi/trap.ts";

/**
 * Per-component-instance runtime state (definitions.py `ComponentInstance`).
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
  handles: Table<unknown> = new Table();
  mayEnter = true;
  backpressure = 0;
  /** Threads with unfinished work in this instance (reference: `threads`). */
  readonly threads: Set<Thread> = new Set();
  /** Exclusive-thread slot (callback-ABI / sync-lift exclusivity; M2). */
  exclusiveThread: Thread | null = null;

  constructor(index: number) {
    this.index = index;
    this.flags = new WebAssembly.Global({ value: "i32", mutable: true }, 1);
  }

  get mayLeave(): boolean {
    return (this.flags.value as number) !== 0;
  }

  set mayLeave(v: boolean) {
    this.flags.value = v ? 1 : 0;
  }

  /**
   * Reference `ComponentInstance.enter_from` / `leave_to`, degenerate form:
   * component ancestry is not modeled in M0 (one flat instance space), so
   * the entering set is just this instance.
   */
  enter(): void {
    assert_(this.mayEnter, "enter() without may_enter");
    this.mayEnter = false;
  }

  leave(): void {
    assert_(!this.mayEnter, "leave() without matching enter()");
    this.mayEnter = true;
  }
}

export type TaskState = "initial" | "started" | "resolved";

export type OnStart = () => ComponentValue[];
export type OnResolve = (result: ComponentValue[] | null) => void;

/**
 * One export activation (definitions.py `Task`). Also the task-side borrow
 * scope: `numBorrows` satisfies cabi's `TaskBorrowScope`.
 */
export class Task {
  state: TaskState = "initial";
  /** TaskBorrowScope (cabi/context.ts): live borrows lowered into this task. */
  numBorrows = 0;
  implicitThread: Thread | null = null;
  readonly threads: Thread[] = [];

  constructor(
    public ft: FuncType,
    public inst: ComponentInstanceState,
    public onStart: OnStart,
    public onResolve: OnResolve,
  ) {}

  /** Reference `Task.enter_implicit_thread` (sync/degenerate branch). */
  enterImplicitThread(thread: Thread): boolean {
    assert_(this.state === "initial");
    this.implicitThread = thread;
    if (this.ft.async) {
      // Backpressure / exclusivity waiting is M2 scheduler work.
      throw new NotImplemented(
        "async-typed function tasks (M2 task scheduler)",
      );
    }
    this.registerThread(thread);
    return true;
  }

  registerThread(thread: Thread): void {
    assert_(!this.threads.includes(thread) && thread.task === this);
    this.threads.push(thread);
    this.inst.threads.add(thread);
  }

  exitImplicitThread(thread: Thread): void {
    assert_(thread === this.implicitThread);
    this.unregisterThread(thread);
  }

  unregisterThread(thread: Thread): void {
    const i = this.threads.indexOf(thread);
    assert_(i !== -1 && thread.task === this);
    this.threads.splice(i, 1);
    if (this.threads.length === 0) {
      trapIf(
        this.state !== "resolved",
        "task finished all threads without resolving",
      );
      assert_(this.numBorrows === 0, "task exited with live borrows");
    }
    this.inst.threads.delete(thread);
  }

  /** Reference `Task.start`: deliver arguments, transition to started. */
  start(): ComponentValue[] {
    assert_(this.state === "initial");
    this.state = "started";
    return this.onStart();
  }

  /** Reference `Task.return_`: deliver results, transition to resolved. */
  return_(result: ComponentValue[]): void {
    trapIf(this.state === "resolved", "task.return on resolved task");
    trapIf(this.numBorrows > 0, "task returned with live borrows");
    this.onResolve(result);
    this.state = "resolved";
  }
}

/**
 * A suspendable computation (definitions.py `Thread`). In M0 there is no
 * suspension mechanism (JSPI wiring is M2): `resume()` runs the body
 * synchronously to completion, and `waitUntil` — the only way a thread could
 * block — is NotImplemented. The scheduler surface (`ready`/`resume`) is
 * kept reference-shaped so the M2 scheduler replaces the internals, not the
 * callers.
 */
export class Thread {
  #fn: (() => void) | null;
  done = false;

  constructor(public task: Task, fn: () => void) {
    this.#fn = fn;
  }

  /** A thread is ready when it has unstarted or resumable work. */
  ready(): boolean {
    return !this.done && this.#fn !== null;
  }

  /** Run to completion (M0: no suspension points can exist). */
  resume(): void {
    assert_(this.ready(), "resume() on non-ready thread");
    const fn = this.#fn!;
    this.#fn = null;
    try {
      fn();
    } finally {
      this.done = true;
    }
  }

  /**
   * Reference `Thread.wait_until` — the M2 suspension point (JSPI /
   * scheduler Promise). Any M0 code path reaching this is a blocking
   * operation inside a sync-only runtime.
   */
  waitUntil(_cond: () => boolean): never {
    throw new NotImplemented("Thread.waitUntil (M2 task scheduler)");
  }
}

/**
 * An in-progress call from this component to an import (definitions.py
 * `Subtask`). Doubles as the subtask-side borrow scope: `addLender`
 * satisfies cabi's `SubtaskBorrowScope`. M0 uses it on the degenerate sync
 * lowered-import path: created STARTING, started/returned within the same
 * synchronous call.
 */
export class Subtask {
  state: "starting" | "started" | "returned" = "starting";
  lenders: { numLends: number }[] = [];

  /** SubtaskBorrowScope (cabi/context.ts). */
  addLender(h: { numLends: number }): void {
    h.numLends += 1;
    this.lenders.push(h);
  }

  onStart(): void {
    assert_(this.state === "starting");
    this.state = "started";
  }

  onReturn(): void {
    assert_(this.state === "started");
    this.state = "returned";
  }

  /** Reference `Subtask.deliver_resolve`: release lent handles. */
  deliverResolve(): void {
    assert_(this.state === "returned");
    for (const h of this.lenders) h.numLends -= 1;
    this.lenders.length = 0;
  }
}

/**
 * The sync driving loop of the reference `canon_lift`:
 *
 * ```python
 * thread.resume()
 * if not ft.async_:
 *   while task.state != Task.State.RESOLVED:
 *     candidates = {ready threads of inst, minus exclusive}
 *     trap_if(not candidates)
 *     random.choice(candidates).resume()
 * ```
 *
 * Determinism note (PLAN.md §15): where the reference chooses randomly among
 * ready threads, this scheduler picks FIFO — within spec-allowed
 * nondeterminism, reproducible for debugging.
 */
export function driveTaskToResolution(task: Task, thread: Thread): void {
  thread.resume();
  while (task.state !== "resolved") {
    const candidates = [...task.inst.threads].filter(
      (t) => t.ready() && t !== task.inst.exclusiveThread,
    );
    trapIf(
      candidates.length === 0,
      "deadlock: task cannot resolve and no thread is ready",
    );
    candidates[0].resume();
  }
}
