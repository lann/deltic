// Deferred run_tests.py areas: explicitly-ignored placeholders so `deno test`
// output shows what is not yet ported and why.
//
// M2 phase 1 (task core + callback ABI) landed the task/thread/waitable
// machinery, so the entries that were blocked purely on "the scheduler does
// not exist" are gone — their content now lives in real tests:
//
//   test_async_callback, test_callback_interleaving, test_async_backpressure,
//   test_sync_ignores_backpressure   -> tests/task_test.ts
//   test_async_to_async, test_async_to_sync, test_async_flat_params
//                                    -> tests/async_lower_test.ts
//                                       + tests/integration/e2e_async_test.ts
//   test_cancel_subtask (host side)  -> tests/task_test.ts (cancellation)
//   test_roundtrips (driving loop)   -> tests/task_test.ts (sync driving loop,
//                                       deadlock trap) + the e2e suites
//   stream/future + error-context    -> the value types are implemented
//   lift/lower                          (cabi/async_values.ts) and the copy
//                                       protocol lives in task/streams.ts
//
// What remains ignored is blocked on a *capability*, not on the scheduler:
// stream/future copy machinery (M2 phase 2) and genuine wasm-stack suspension
// (JSPI, M2 phase 3). Each entry names which.

const deferred: [name: string, reason: string][] = [
  [
    "test_cross_component_realloc",
    "needs the component instance *tree* (ComponentInstance.parent) so a " +
    "callee can reach a caller's realloc across a nested lift; the plan has " +
    "no wire form for instance nesting (see the CONTRACT note on " +
    "ComponentInstanceState.enteringSet) — v0.3 contract friction, not a " +
    "scheduler gap",
  ],
  [
    "test_handles (full port)",
    "needs host-function Threads reaching back into a component (the " +
    "reference's mk_host_func runs host code on a real Thread); our host " +
    "imports are plain JS functions, so Task-scoped borrow lifetime at task " +
    "exit is covered instead by handles_test.ts + the resources e2e suite",
  ],
  [
    "stream/future tests: test_eager_stream_completion, test_async_stream_ops, " +
    "test_stream_forward, test_receive_own_stream, test_host_partial_reads_writes, " +
    "test_wasm_to_wasm_stream(_empty), test_cancel_copy, test_futures, " +
    "test_self_copy",
    "the copy machinery now exists (runtime/src/task/streams.ts + " +
    "intrinsics/stream_builtins.ts) and is exercised by the official async " +
    "suite; these particular run_tests.py ports additionally need HOST-side " +
    "stream ends (the reference's tests drive a stream from Python), which is " +
    "a host API we have not designed — tracked separately from the guest-side " +
    "machinery, which is done",
  ],
  [
    "test_sync_using_wait",
    "needs JSPI (M2 phase 3): a *sync* task calling waitable-set.wait blocks " +
    "its wasm frame; the task core implements the non-blocking branch " +
    "(an already-pending event) and fails loudly otherwise",
  ],
  [
    "test_thread_cancel_callback",
    "needs JSPI (M2 phase 3): the reference cancels a thread parked inside a " +
    "blocking built-in; from a stackless guest there is no such parked frame",
  ],
  [
    "threads: test_threads, test_sync_threads (thread.* built-ins)",
    "🧵 shared-everything threads (thread.new-indirect, " +
    "thread.{suspend,resume-later,switch-to,...}) are deferred with memory64 " +
    "per PLAN.md §16; context.get/set — the part of this group that async " +
    "guests actually use — IS implemented (intrinsics/context.ts)",
  ],
];

for (const [name, reason] of deferred) {
  Deno.test({
    name: `DEFERRED: ${name}`,
    ignore: true,
    fn() {
      throw new Error(`deferred: ${reason}`);
    },
  });
}
