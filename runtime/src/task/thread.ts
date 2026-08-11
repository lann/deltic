// definitions.py `class Thread` (line 317), reimplemented over JS generators.
//
// Mapping to the reference, state for state:
//
//   reference                    here
//   ------------------------------------------------------------------
//   cont is None (running)       #state === "running"
//   cont set, ready_func None    #state === "suspended"
//   cont set, ready_func set     #state === "waiting"  (in store.waiting)
//   thread.storage[2]            storage: [0, 0]   (context.{get,set})
//   thread.index                 index (inst.threads table slot)
//
// The reference's `resume()` drives a chain of `switch_to` handoffs
// (`suspend_then_resume` and friends, lines 408-437). Those are the 🧵
// shared-everything-threads built-ins, which https://github.com/lann/deltic/issues/12 defers along with
// memory64; `resume()` here therefore handles a single thread, and the
// switch-to variants are absent rather than approximated.

import { assert_ } from "../cabi/trap.ts";
import {
  type BlockRequest,
  type Cancelled,
  CANCELLED_FALSE,
  CANCELLED_TRUE,
  NeedsJspi,
  notifyInstancePoisoned,
  isInstancePoisoned,
  PendingCapability,
  popCurrentThread,
  pushCurrentThread,
  type SchedulableThread,
  type Store,
  type ThreadBody,
} from "./scheduler.ts";

type ThreadState = "running" | "suspended" | "waiting" | "done";

export class Thread implements SchedulableThread {
  /**
   * Per-thread context slots (definitions.py `Thread.storage`, line 323 —
   * initialised `[0,0]`). `canon_context_{get,set}` (lines 2348/2358) read and
   * write *this*, not per-task state: two threads of the same task have
   * independent context. wit-bindgen 0.60 keeps its async task pointer in
   * slot 0.
   */
  readonly storage: number[] = [0, 0];

  /**
   * The FACT sync-call bracket stack for THIS activation.
   *
   * `enter-sync-call` pushes and `exit-sync-call` pops; FACT emits both from
   * the same activation, so the activation is the continuity that makes this a
   * stack. See the note on `Task.syncCallStack` for why per-task was not
   * enough.
   */
  // deno-lint-ignore no-explicit-any
  readonly syncCallStack: any[] = [];

  /** Slot in `inst.threads`, assigned by `Task.registerThread`. */
  index: number | null = null;

  /** definitions.py `Thread.cancellable` — set at each block point. */
  cancellable = false;

  #state: ThreadState = "suspended";
  #body: ThreadBody;
  #readyFunc: (() => boolean) | null = null;
  #store: Store;

  // deno-lint-ignore no-explicit-any
  constructor(public task: any, body: ThreadBody) {
    this.#body = body;
    this.#store = task.inst.store;
  }

  running(): boolean {
    return this.#state === "running";
  }

  suspended(): boolean {
    return this.#state === "suspended";
  }

  waiting(): boolean {
    return this.#state === "waiting";
  }

  done(): boolean {
    return this.#state === "done";
  }

  /** definitions.py `Thread.ready` (line 334). */
  ready(): boolean {
    return this.waiting() && this.#readyFunc !== null && this.#readyFunc();
  }

  /** definitions.py `Thread.start_waiting_internal` (line 350). */
  #startWaiting(readyFunc: () => boolean): void {
    assert_(!this.waiting() && this.#readyFunc === null);
    this.#readyFunc = readyFunc;
    this.#state = "waiting";
    this.#store.startWaiting(this);
  }

  /** definitions.py `Thread.stop_waiting_internal` (line 355). */
  #stopWaiting(cancelled: Cancelled): void {
    assert_(this.waiting() && this.#readyFunc !== null);
    assert_(
      cancelled || this.ready(),
      "stopWaiting on a thread that is neither ready nor cancelled",
    );
    this.#readyFunc = null;
    this.#state = "suspended";
    this.#store.stopWaiting(this);
  }

  /** definitions.py `Thread.resume_later` (line 361). */
  resumeLater(): void {
    assert_(this.suspended(), "resume_later on a non-suspended thread");
    this.#startWaiting(() => true);
  }

  /**
   * definitions.py `Thread.resume` (line 366): run the body until it blocks
   * again or finishes.
   *
   * The reference's loop over `switch_to` targets is omitted (see the module
   * header). What remains is: leave the waiting list if we were on it, become
   * the current thread, and step the generator with the cancelled flag.
   */
  /** Pending `awaitValue` promise, if this thread is parked on one. */
  awaiting: Promise<unknown> | null = null;

  /** Resume a promise-parked thread with the settled result. */
  resumeWith(value: unknown, failure?: { error: unknown }): void {
    assert_(this.awaiting !== null, "resumeWith on a thread that is not awaiting");
    this.awaiting = null;
    this.#store.awaiting.delete(this);
    this.#state = "suspended";
    // The reentrance bracket, exactly as `Store.tick` puts around `resume()`.
    //
    // Every thread resumption in the reference runs under the instance's
    // entered lock, and a trap propagating out of the resumed thread skips
    // `leave_to` — which is the Component Model's instance poisoning
    // (definitions.py `Store.tick` line 597; see the matching comment in
    // scheduler.ts). This path is a resumption too — the value arrived
    // through a Promise instead of a ready-condition, but the thread body
    // (and any wasm it runs) is the same — so it takes the same bracket.
    // Without it, a trap delivered as an `awaitValue` rejection (how EVERY
    // guest trap in a suspended activation arrives under jspi, pin (e))
    // unwound cleanly and the instance stayed enterable: the second call of
    // `builtin-trap-poisons-instance.wast` then re-ran the guest and
    // reported "cannot drop busy stream" where the suite demands the
    // poisoned-instance "cannot enter component instance".
    //
    // Capability signals release the lock, for the same reason as in `tick`:
    // they mark the RUNTIME incomplete, not the component faulted.
    const inst = this.task.inst;
    // A poisoned instance's parked segments never run again: this settle
    // belongs to an activation that was in flight when a SIBLING activation
    // trapped (the trap kept the reentrance lock — CM poisoning — and #66
    // retired the handle tables). Resuming would re-enter the corpse, and
    // asserting turned one legible trap into an assert cascade (the
    // wosh-M2 shape: `list too long`, then this assert as second victim).
    // Retire quietly: the abandoned call's own driver reports, via its
    // deadlock trap naming the export.
    if (isInstancePoisoned(inst)) return;
    assert_(
      inst.mayEnterFrom(null),
      "resumeWith: parked thread's instance is not enterable from the host",
    );
    inst.enterFrom(null);
    try {
      this.#resumeInternal(value, failure);
    } catch (e) {
      if (e instanceof NeedsJspi || e instanceof PendingCapability) {
        inst.leaveTo(null);
      } else {
        // The bracket stays broken (instance poisoned, comment above) — same
        // as `Store.tick`: retire the poisoned table's stream/future ends so
        // parked host peers settle instead of hanging (#66), and release the
        // synthetic root so the poisoning stays per-instance (plan v3
        // amendment 4; `releaseSyntheticRootOnPoison`).
        inst.releaseSyntheticRootOnPoison();
        notifyInstancePoisoned(
          inst as unknown as { handles: Iterable<unknown> },
          e,
        );
      }
      throw e;
    }
    inst.leaveTo(null);
  }

  resume(cancelled: Cancelled = CANCELLED_FALSE): void {
    assert_(
      !this.running() && !this.done(),
      "resume() on a running or finished thread",
    );
    assert_(
      this.cancellable || !cancelled,
      "cancelled resume of a non-cancellable block point",
    );
    if (this.waiting()) this.#stopWaiting(cancelled);
    this.#resumeInternal(cancelled);
  }

  #resumeInternal(sendValue: unknown, failure?: { error: unknown }): void {
    this.#state = "running";
    pushCurrentThread(this);
    let step: IteratorResult<BlockRequest, void>;
    try {
      step = failure === undefined
        ? this.#body.next(sendValue)
        // Throw the rejection *into* the body so a post-resume trap unwinds
        // through the same `finally`s a synchronous one would (jspi pin (e)).
        : this.#body.throw(failure.error);
    } catch (e) {
      // The body threw (a trap, or one of our capability errors). The thread
      // is finished either way; the exception propagates to whoever was
      // driving the scheduler.
      this.#state = "done";
      throw e;
    } finally {
      popCurrentThread(this);
    }
    if (step.done) {
      this.#state = "done";
      return;
    }
    const req = step.value;
    this.cancellable = req.cancellable;
    if (req.awaitValue !== undefined) {
      // Parked on a Promise, not on a scheduler condition. The driving loop
      // owns it from here (exec/boundary.ts `drive`); parking through
      // `noteAwaiting` arms the eager settle tracking the scheduler's
      // phantom-state gate depends on (see `Store.settled`).
      this.#state = "suspended";
      this.awaiting = req.awaitValue;
      this.#store.noteAwaiting(this, req.awaitValue);
      return;
    }
    if (req.readyFunc === null) {
      // `suspend`: resumable only by an explicit `resume`/`resumeLater`.
      this.#state = "suspended";
    } else {
      this.#state = "suspended";
      this.#startWaiting(req.readyFunc);
    }
  }

  /**
   * definitions.py `Thread.wait_until` (line 396), as a generator-side helper.
   *
   * Call it from a thread body with `yield*`:
   *   `const cancelled = yield* thread.waitUntil(() => cond, true);`
   *
   * Deviation from the reference, deliberate: the reference may return
   * immediately when `ready_func()` already holds
   * (`if ready_func() and not DETERMINISTIC_PROFILE and random.randint(0,1)`).
   * We always take the blocking path, i.e. we behave as the reference's
   * `DETERMINISTIC_PROFILE`. Blocking-then-immediately-ready is observably
   * equivalent (the scheduler will find this thread ready on the next
   * candidate scan) and it removes a coin flip from every wait.
   */
  *waitUntil(
    readyFunc: () => boolean,
    cancellable = false,
  ): Generator<BlockRequest, Cancelled, Cancelled> {
    assert_(this.running(), "waitUntil on a non-running thread");
    if (this.task.deliverPendingCancel(cancellable)) return CANCELLED_TRUE;
    const cancelled = yield { readyFunc, cancellable };
    return cancelled;
  }

  /** definitions.py `Thread.suspend` (line 390). */
  *suspend(cancellable: boolean): Generator<BlockRequest, Cancelled, Cancelled> {
    assert_(this.running(), "suspend on a non-running thread");
    if (this.task.deliverPendingCancel(cancellable)) return CANCELLED_TRUE;
    const cancelled = yield { readyFunc: null, cancellable };
    return cancelled;
  }

  /** definitions.py `Thread.yield_` (line 405): `wait_until(lambda: True)`. */
  *yield_(cancellable: boolean): Generator<BlockRequest, Cancelled, Cancelled> {
    return yield* this.waitUntil(() => true, cancellable);
  }
}
