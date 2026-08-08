// Direct tests for the async canonical built-ins and the callback-ABI loop's
// trap conditions — the paths that are hard to reach through a whole
// component, and where a silent wrong answer is the failure mode.
//
// Reference: definitions.py `canon_waitable_set_wait` / `canon_waitable_set_poll`
// (lines 2421/2438), `unpack_callback_result` (line 2226) and `canon_lift`'s
// callback loop (lines 2183-2214).

import { assertEq } from "./support/asserts.ts";
import { Trap } from "../src/cabi/mod.ts";
import {
  BLOCKED,
  createWaitableSetPoll,
  createWaitableSetWait,
} from "../src/intrinsics/async_builtins.ts";
import {
  createStreamCancelWrite,
  createStreamNew,
  createStreamRead,
  createStreamWrite,
} from "../src/intrinsics/stream_builtins.ts";
import {
  createLiftedFunction,
  newStats,
  type ResolvedOptions,
  unpackCallbackResult,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  CopyResult,
  EventCode,
  NeedsJspi,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  type TaskOptions,
  Thread,
  Waitable,
  WaitableSet,
} from "../src/task/mod.ts";
import type { FuncType, ValType } from "../src/cabi/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertTraps(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (e) {
    assert(e instanceof Trap, `expected a Trap, got ${e}`);
    assert(
      String(e).includes(includes),
      `expected trap containing ${JSON.stringify(includes)}, got: ${e}`,
    );
    return;
  }
  throw new Error(`expected a trap containing ${JSON.stringify(includes)}`);
}

const ASYNC_FT: FuncType = { params: [], results: [], async: true };
const CALLBACK_OPTS: TaskOptions = {
  async_: true,
  callback: true,
  stringEncoding: "utf8",
  memory: null,
};

/** A live `MemInst` view over a real WebAssembly.Memory. */
function mkMemory() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  return {
    memory,
    view: {
      addrType: "i32" as const,
      get bytes() {
        return new Uint8Array(memory.buffer);
      },
      get view() {
        return new DataView(memory.buffer);
      },
      get length() {
        return memory.buffer.byteLength;
      },
      ptrType: () => "i32" as const,
      ptrSize: () => 4 as const,
    },
  };
}

// ---------------------------------------------------------------------------
// `cancellable` comes from the canonical options, not the trampoline
// ---------------------------------------------------------------------------
//
// `Trampoline::WaitableSetWait` / `WaitableSetPoll` carry only
// `{instance, options}` (wasmtime-environ 47.0.3 `component/info.rs:815-831`);
// `CanonicalOptions.cancellable` (info.rs:540) is where the flag lives, and it
// is definitions.py's `cancellable` parameter. Reading it from the decl always
// yielded `false`, which silently made every pending cancellation
// undeliverable through these two built-ins.

interface WaitFixture {
  inst: ComponentInstanceState;
  task: Task;
  wset: WaitableSet;
  seti: number;
  memory: WebAssembly.Memory;
  ctx: {
    componentInstance: (i: number) => ComponentInstanceState;
    options: (i: number) => ResolvedOptions;
    resultTypes: (i: number) => ValType[];
  };
  opts: ResolvedOptions;
  run<T>(fn: () => T): T;
}

function mkWaitFixture(cancellable: boolean): WaitFixture {
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const { memory, view } = mkMemory();
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: view as any,
    realloc: null,
    postReturn: null,
    callback: null,
    async: true,
    cancellable,
    coreType: { params: ["i32", "i32"], results: ["i32"] },
    instance: inst,
  };
  const wset = new WaitableSet();
  const seti = inst.handles.add(wset);
  const task = new Task(ASYNC_FT, CALLBACK_OPTS, inst, () => [], () => {});
  const thread = new Thread(task, (function* () {})());
  return {
    inst,
    task,
    wset,
    seti,
    memory,
    opts,
    ctx: {
      componentInstance: () => inst,
      options: () => opts,
      resultTypes: () => [],
    },
    run<T>(fn: () => T): T {
      pushCurrentThread(thread);
      try {
        return fn();
      } finally {
        popCurrentThread(thread);
      }
    },
  };
}

Deno.test("waitable-set.wait: a cancellable wait delivers TASK_CANCELLED", () => {
  const f = mkWaitFixture(true);
  const wait = createWaitableSetWait({ options: 0 }, f.ctx, f.inst);
  // A cancellation that could not be delivered to a cancellable block point
  // yet (definitions.py `Task.request_cancellation` -> PENDING_CANCEL).
  f.task.state = "pending-cancel";
  const code = f.run(() => wait(f.seti, 64)) as number;
  assertEq(code, EventCode.TASK_CANCELLED);
  // definitions.py `Task.deliver_pending_cancel`: delivery moves the task on.
  assertEq(f.task.state, "cancel-delivered");
  // `unpack_event` (line 2429) stores the two payload words; both are 0 for
  // TASK_CANCELLED.
  const dv = new DataView(f.memory.buffer);
  assertEq(dv.getUint32(64, true), 0);
  assertEq(dv.getUint32(68, true), 0);
});

Deno.test("waitable-set.wait: a non-cancellable wait does not deliver it", () => {
  const f = mkWaitFixture(false);
  const wait = createWaitableSetWait({ options: 0 }, f.ctx, f.inst);
  f.task.state = "pending-cancel";
  // Give the set a real pending event, so the non-cancellable wait has
  // something to return and we can see it returns *that*, not TASK_CANCELLED.
  const elem = new Waitable();
  elem.join(f.wset);
  elem.setPendingEvent(() => [EventCode.SUBTASK, 7, 2]);

  const code = f.run(() => wait(f.seti, 64)) as number;
  assertEq(code, EventCode.SUBTASK);
  // The pending cancellation was NOT consumed: a non-cancellable block point
  // may not deliver it (definitions.py `Task.deliver_pending_cancel`, line
  // 536 — `if cancellable and ...`).
  assertEq(f.task.state, "pending-cancel");
  const dv = new DataView(f.memory.buffer);
  assertEq(dv.getUint32(64, true), 7);
  assertEq(dv.getUint32(68, true), 2);
});

Deno.test("waitable-set.poll: cancellable vs non-cancellable", () => {
  const yes = mkWaitFixture(true);
  const pollYes = createWaitableSetPoll({ options: 0 }, yes.ctx, yes.inst);
  yes.task.state = "pending-cancel";
  assertEq(yes.run(() => pollYes(yes.seti, 64)), EventCode.TASK_CANCELLED);
  assertEq(yes.task.state, "cancel-delivered");

  const no = mkWaitFixture(false);
  const pollNo = createWaitableSetPoll({ options: 0 }, no.ctx, no.inst);
  no.task.state = "pending-cancel";
  // definitions.py `WaitableSet.poll`: not cancellable and no event -> NONE.
  assertEq(no.run(() => pollNo(no.seti, 64)), EventCode.NONE);
  assertEq(no.task.state, "pending-cancel");
});

Deno.test("waitable-set.wait: without an event and without a cancel, needs JSPI", () => {
  const f = mkWaitFixture(true);
  const wait = createWaitableSetWait({ options: 0 }, f.ctx, f.inst);
  f.task.state = "started";
  let raised: unknown;
  try {
    f.run(() => wait(f.seti, 64));
  } catch (e) {
    raised = e;
  }
  assert(raised instanceof NeedsJspi, `expected NeedsJspi, got ${raised}`);
});

// ---------------------------------------------------------------------------
// The callback-ABI loop's trap conditions (A2)
// ---------------------------------------------------------------------------

Deno.test("unpack_callback_result: a code above MAX traps", () => {
  // definitions.py line 2226: `trap_if(code > CallbackCode.MAX)`, MAX = 2.
  assertEq(unpackCallbackResult(0), [0, 0]);
  assertEq(unpackCallbackResult(2 | (5 << 4)), [2, 5]);
  assertTraps(() => unpackCallbackResult(3), "invalid callback code 3");
  assertTraps(() => unpackCallbackResult(15), "invalid callback code 15");
});

/** Build a lifted async export whose core function returns `packed`. */
function mkCallbackExport(input: {
  packed: number;
  inst?: ComponentInstanceState;
  onCallback?: () => number;
}) {
  const inst = input.inst ??
    new ComponentInstanceState(0, new Store());
  const ft: FuncType = { params: [], results: [], async: true };
  const callback: () => number = input.onCallback ?? (() => 0);
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    memory: null,
    realloc: null,
    postReturn: null,
    callback: () => callback as never,
    async: true,
    cancellable: false,
    coreType: { params: [], results: ["i32"] },
    instance: inst,
  };
  return {
    inst,
    fn: createLiftedFunction({
      name: "cb-export",
      ft,
      opts,
      core: () => input.packed,
      stats: newStats(),
    }),
  };
}

Deno.test("callback loop: WAIT with an index that is not a waitable set traps", () => {
  const inst = new ComponentInstanceState(0, new Store());
  // Put a non-WaitableSet in the handle table so the lookup *succeeds* and the
  // type check is what rejects it (definitions.py line 2192:
  // `trap_if(not isinstance(wset, WaitableSet))`).
  const notASet = inst.handles.add({ definitelyNot: "a waitable set" });
  const { fn } = mkCallbackExport({
    packed: 2 | (notASet << 4), // CallbackCode.WAIT
    inst,
  });
  assertTraps(() => fn(), "not a waitable set");
});

Deno.test("callback loop: EXIT without resolving the task traps", () => {
  // definitions.py `Task.unregister_thread` (line 510):
  // `trap_if(self.state != Task.State.RESOLVED)` once the last thread goes.
  const { fn } = mkCallbackExport({ packed: 0 }); // CallbackCode.EXIT
  assertTraps(() => fn(), "without resolving");
});

// ---------------------------------------------------------------------------
// Cancelling a partially-satisfied stream copy
// ---------------------------------------------------------------------------

Deno.test("stream.cancel-write supersedes an undelivered COMPLETED", () => {
  // Minimal shape of `test/async/big-interleaving-test.wast:1520`:
  //   write 8  -> BLOCKED (parks, no reader yet)
  //   read  4  -> COMPLETED | 4   (rendezvous, writer partially satisfied)
  //   cancel-write -> CANCELLED | 4
  //
  // The third step is where definitions.py and wasmtime disagree.
  // `cancel_copy` (line 2652) returns the writer's already-armed pending event
  // verbatim, which is COMPLETED|4; wasmtime converts an *undelivered* stream
  // COMPLETED into CANCELLED with the count preserved
  // (`futures_and_streams.rs:4004-4015`), and the suite asserts wasmtime's
  // answer. Getting this wrong is silent: the guest is told its write finished
  // when it was actually cancelled with 4 of 8 elements copied.
  const store = new Store();
  const inst = new ComponentInstanceState(0, store);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = {
    addrType: "i32" as const,
    get bytes() {
      return new Uint8Array(memory.buffer);
    },
    get view() {
      return new DataView(memory.buffer);
    },
    get length() {
      return memory.buffer.byteLength;
    },
    ptrType: () => "i32" as const,
    ptrSize: () => 4 as const,
  };
  const opts: ResolvedOptions = {
    stringEncoding: "utf8",
    // deno-lint-ignore no-explicit-any
    memory: view as any,
    realloc: null,
    postReturn: null,
    callback: null,
    async: true,
    cancellable: false,
    coreType: { params: [], results: [] },
    instance: inst,
  };
  const ctx = {
    componentInstance: () => inst,
    options: () => opts,
    streamElem: () => ({ kind: "u8" } as const),
    futureElem: () => null,
  };

  // deno-lint-ignore no-explicit-any
  const newStream = createStreamNew({ streamTable: 0 }, ctx as any, inst);
  // deno-lint-ignore no-explicit-any
  const write = createStreamWrite({ streamTable: 0, options: 0 }, ctx as any, inst);
  // deno-lint-ignore no-explicit-any
  const read = createStreamRead({ streamTable: 0, options: 0 }, ctx as any, inst);
  const cancelWrite = createStreamCancelWrite(
    { streamTable: 0, async: true },
    // deno-lint-ignore no-explicit-any
    ctx as any,
    inst,
  );

  const packed = newStream() as bigint;
  const ri = Number(packed & 0xffff_ffffn);
  const wi = Number(packed >> 32n);

  const task = new Task(
    { params: [], results: [], async: true },
    { async_: true, callback: true, stringEncoding: "utf8", memory: null },
    inst,
    () => [],
    () => {},
  );
  const thread = new Thread(task, (function* () {})());
  pushCurrentThread(thread);
  try {
    // 8 elements at offset 0, no reader yet: parks.
    assertEq(write(wi, 0, 8), BLOCKED);
    // 4 elements into offset 64: rendezvous, COMPLETED with progress 4.
    const r = read(ri, 64, 4) as number;
    assertEq(r & 0xf, CopyResult.COMPLETED);
    assertEq(r >> 4, 4);
    // The writer still has 4 of its 8 outstanding and an undelivered
    // COMPLETED event. Cancelling must report CANCELLED, keeping the count.
    const cw = cancelWrite(wi) as number;
    assertEq(cw & 0xf, CopyResult.CANCELLED);
    assertEq(cw >> 4, 4);
    assertEq(cw, 0x42);
  } finally {
    popCurrentThread(thread);
  }
});
