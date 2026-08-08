// Deferred run_tests.py areas: explicitly-ignored placeholders so `deno test`
// output shows what is not yet ported and why. Each maps to run_tests.py
// tests that require the task/thread/waitable machinery (PLAN.md §6 — the
// scheduler is the core M2 deliverable and will be built as the runtime's
// spine, not bolted on here).

const deferred: [name: string, reason: string][] = [
  [
    "test_roundtrips (canon_lift/canon_lower driving loop)",
    "needs canon_lift/canon_lower + Task/Thread + Store scheduler; the value " +
    "lower->memory->lift mechanics are covered by flat/heap/values tests",
  ],
  [
    "test_cross_component_realloc",
    "needs Store/ComponentInstance nesting, context.get/set, thread identity " +
    "asserts, and realloc routed through canon_lift",
  ],
  [
    "test_handles (full port)",
    "needs lift_and_run (canon_lift), host func Threads, and Task-scoped " +
    "borrow lifetime enforcement at task exit; pure table/handle logic is " +
    "covered by handles_test.ts",
  ],
  [
    "error-context value type (lift/lower + canon error-context.*)",
    "lift_error_context/lower_error_context need instance handle tables tied " +
    "to running tasks; sizes/flatten are covered",
  ],
  [
    "stream/future value types (lift/lower)",
    "need ReadableStreamEnd/CopyEnd state machines; sizes/flatten are covered",
  ],
  [
    "async tests: test_async_to_async, test_async_callback, " +
    "test_callback_interleaving, test_sync_ignores_backpressure, " +
    "test_async_to_sync, test_async_backpressure, test_sync_using_wait, " +
    "test_async_flat_params",
    "task/subtask lifecycle, waitable sets, callback ABI, backpressure — " +
    "PLAN.md §6 core deliverable (M2); flatten of async signatures IS " +
    "covered in layout_flatten_test.ts",
  ],
  [
    "stream/future tests: test_eager_stream_completion, test_async_stream_ops, " +
    "test_stream_forward, test_receive_own_stream, test_host_partial_reads_writes, " +
    "test_wasm_to_wasm_stream(_empty), test_cancel_copy, test_futures, " +
    "test_self_copy",
    "stream/future copy machinery + scheduler",
  ],
  [
    "cancellation: test_cancel_subtask, test_thread_cancel_callback",
    "subtask cancellation protocol needs the scheduler",
  ],
  [
    "threads: test_threads, test_sync_threads (thread.* built-ins, " +
    "context.get/set)",
    "cooperative thread machinery (cont_new/resume/block) is the JSPI " +
    "mapping layer (PLAN.md §6), out of scope for the value interpreter",
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
