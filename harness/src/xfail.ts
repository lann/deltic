// Checked-in triage list: commands known to fail against the current
// runtime, with a reason, so the conformance run's summary distinguishes
// "known, triaged failure" (xfail) from "unexpected regression" (failed).
// Keyed by `{file, line}` — `line` is the command's 1-based source line
// from testgen's JSON (stable across regen: same suite source -> same
// line), which uniquely identifies a command within a file.
//
// Entries here are removed as the runtime gains the capability that makes
// them pass; an xfail entry whose command now PASSES is not automatically
// flagged (deno_task conformance doesn't cross-check xfail-vs-actual
// tightening) — check the summary's `xfail` column against this list's
// length periodically.

export interface XfailEntry {
  /** relative path under harness/generated/, e.g. "linking/unit.json". */
  file: string;
  /** 1-based source line (`Command.line`) of the failing command. */
  line: number;
  reason: string;
}

export const XFAIL: XfailEntry[] = [
  // --- binary/binary.json: translator-shim (crates/translator-shim, not
  // harness territory) gaps hit by the M1-scope binary-encoding suite. ---
  {
    file: "binary/binary.json",
    line: 962,
    reason:
      "translator error [validation]: invalid boolean value — the shim's " +
      "`thread.index`/threading-feature-gated encoding path rejects a " +
      "binary this suite expects to translate; crates/translator-shim gap " +
      "(pending-capability: threading feature binary encoding)",
  },
  {
    file: "binary/binary.json",
    line: 1194,
    reason:
      "translator error [validation]: invalid leading byte (0x2) for name " +
      "option — the shim's component-name-section decoder rejects a valid " +
      "encoding this suite exercises; crates/translator-shim gap " +
      "(pending-capability: name-option encoding)",
  },
  {
    file: "binary/binary.json",
    line: 1421,
    reason:
      "translator error [unsupported]: module exports are not supported in " +
      "plan v0 — plan-format.md doesn't yet have a wire shape for exporting " +
      "a bare core module; crates/translator-shim + contracts/plan-format.md " +
      "gap (pending-capability: core-module export in plan v0)",
  },
  // --- validation/attributes.json: same name-option decoding gap as
  // binary/binary.json:1194 above. ---
  {
    file: "validation/attributes.json",
    line: 30,
    reason:
      "translator error [validation]: invalid leading byte (0x2) for name " +
      "option — same crates/translator-shim name-option decoding gap as " +
      "binary/binary.json:1194 (pending-capability: name-option encoding)",
  },
  {
    file: "validation/attributes.json",
    line: 213,
    reason: "same name-option decoding gap as line 30, see that entry",
  },
  // --- values/post-return.json: three of the file's five components need
  // the M2 task core, so their instances never come up and every command
  // against them fails. Root causes below; none is a values/-specific gap.
  //
  // post-return.wast:4 ($Tester) declares every async built-in
  // (task.return, task.cancel, thread.yield/index, waitable-set.*,
  // waitable.join, subtask.*, stream.*, future.*) in order to assert they
  // trap when called from a post-return function. The runtime refuses the
  // component at instantiate time on the first such trampoline
  // (contracts/intrinsics.md §B: M2), so all 28 assert_trap commands below
  // are blocked on the same capability.
  {
    file: "values/post-return.json",
    line: 202,
    reason:
      "UnsupportedFeatureError: component requires host trampoline " +
      "'task-return' — post-return.wast:4 declares the full async built-in " +
      "surface; runtime/src/intrinsics gap " +
      "(pending-capability: M2 task core)",
  },
  {
    file: "values/post-return.json",
    line: 204,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 206,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 208,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 210,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 212,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 214,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 216,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 218,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 220,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 222,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 224,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 226,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 228,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 230,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 232,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 234,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 236,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 238,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 240,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 242,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 244,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 246,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 248,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 250,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 252,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 254,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 256,
    reason: "same M2 task-core dependency as line 202, see that entry",
  },
  // post-return.wast:260 uses `context.get`/`context.set`, which wasmtime
  // lowers to `CoreDef::UnsafeIntrinsic` — a shape plan v0 has no wire form
  // for (plan-format.md v0.1 amendments; the known M2 blocker).
  // post-return.wast:334 calls `backpressure.inc`/`backpressure.dec` from a
  // post-return function. NOTE the observed symptom is a *wrong value*
  // ("expected u32 11, got 5"), not an error: the module command fails as a
  // capability skip and the invoke then runs against the previously
  // instantiated component, which also exports `f`. The value mismatch is an
  // artifact of that, not a canonical-ABI bug.
  // --- values/variants.json: variants.wast:83's component exports an
  // async-lifted function (`mix-ret`, `canon lift ... async`) whose
  // `task.return` trampoline is a core instantiation argument, so the whole
  // component is refused at instantiate time and its three *sync* exports
  // are unreachable too. The plan maps all four exports correctly — pinned by
  // runtime/tests/integration/e2e_suite_test.ts ("exports are mapped;
  // refusal is loud"). ---
  {
    file: "values/variants.json",
    line: 183,
    reason:
      "UnsupportedFeatureError: component requires host trampoline " +
      "'task-return' — variants.wast:83 mixes an async-lifted export with " +
      "sync ones; runtime/src/intrinsics gap " +
      "(pending-capability: M2 task core)",
  },
  {
    file: "values/variants.json",
    line: 184,
    reason: "same M2 task-core dependency as line 183, see that entry",
  },
  {
    file: "values/variants.json",
    line: 185,
    reason: "same M2 task-core dependency as line 183, see that entry",
  },
  {
    file: "values/variants.json",
    line: 186,
    reason: "same M2 task-core dependency as line 183, see that entry",
  },

  // =====================================================================
  // async/ — M2 phase 1 (task core + callback ABI) triage.
  //
  // What now works and is NOT listed here: `trap-on-reenter`,
  // `validate-no-async-abi-for-sync-type` and `validate-no-stream-char` are
  // fully green, and individual commands pass in eight more files.
  //
  // What blocks the rest, in order of weight:
  //   * FACT cross-component async calls (`async-start-call`,
  //     `sync-start-call`) — 49 commands. This phase implements the async ABI
  //     at the *host* boundary; the suite almost always drives async through a
  //     second component, which goes via FACT's adapter intrinsics instead.
  //   * streams / futures — 41 commands (M2 phase 2, out of this track).
  //   * 166 further commands are *cascades*: once a component instance is
  //     declined at instantiation, every later command against it fails with
  //     "no current instance". They carry the root cause's reason.
  //   * 4 genuine one-off gaps, each with its own entry (trap-message
  //     fidelity, instance poisoning, instantiation-time task context, and one
  //     shim decoder gap).
  // =====================================================================
  // --- async/async-calls-sync.json: root cause: FACT-SYNC ---
  {
    file: "async/async-calls-sync.json",
    line: 250,
    reason:
      "pending-capability: FACT cross-component sync-to-async calls " +
      "(M2 phase 2) — the adapters import `sync-start-call`, the FACT " +
      "intrinsic for a sync-lifted caller invoking an async callee " +
      "across a component boundary. Instantiation is declined, so " +
      "every command against the instance follows",
  },
  {
    file: "async/async-calls-sync.json",
    line: 251,
    reason:
      "same blocking capability as line 250, see that entry",
  },
  // --- async/big-interleaving-test.json: root cause: STREAMS ---
  {
    file: "async/big-interleaving-test.json",
    line: 825,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 827,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 836,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 844,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 856,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 863,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 873,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 884,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 896,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 906,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 914,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 934,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 946,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 964,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1024,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1058,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1104,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1132,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1160,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1206,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1256,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1288,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1344,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1392,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1407,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1417,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1427,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1438,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1448,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1457,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1469,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1481,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1491,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1504,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1520,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1533,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1544,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1555,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1568,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1584,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1594,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1603,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1614,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1633,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  {
    file: "async/big-interleaving-test.json",
    line: 1644,
    reason:
      "same blocking capability as line 825, see that entry",
  },
  // --- async/builtin-trap-poisons-instance.json: root cause: STREAMS ---
  {
    file: "async/builtin-trap-poisons-instance.json",
    line: 38,
    reason:
      "pending-capability: streams (M2 phase 2) — this component's `f` " +
      "drives stream.new/write/drop-writable to prove a *built-in* trap " +
      "poisons too; the stream built-ins are deferred-capability " +
      "trampolines until the copy machinery lands. (The two non-stream " +
      "assertions in this file, lines 9 and 10, now pass: instance " +
      "poisoning and wasmtime trap-message parity both landed.)",
  },
  // --- async/cancel-stream.json: root cause: STREAMS ---
  {
    file: "async/cancel-stream.json",
    line: 202,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  // --- async/cancel-subtask.json: root cause: FACT-ASYNC ---
  {
    file: "async/cancel-subtask.json",
    line: 201,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  // --- async/cancellable.json: root cause: FACT-ASYNC ---
  {
    file: "async/cancellable.json",
    line: 322,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  // --- async/closed-stream.json: root cause: STREAMS ---
  {
    file: "async/closed-stream.json",
    line: 102,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  // --- async/cross-abi-calls.json: root cause: FACT-ASYNC ---
  {
    file: "async/cross-abi-calls.json",
    line: 473,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 475,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 477,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 479,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 481,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 483,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 485,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 487,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 489,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 491,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 493,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 495,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 497,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 499,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 501,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 503,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 505,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 507,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 509,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 511,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 513,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 515,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 517,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  {
    file: "async/cross-abi-calls.json",
    line: 519,
    reason:
      "same blocking capability as line 473, see that entry",
  },
  // --- async/cross-task-future.json: root cause: STREAMS ---
  {
    file: "async/cross-task-future.json",
    line: 103,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  // --- async/deadlock.json: root cause: FACT-ASYNC ---
  {
    file: "async/deadlock.json",
    line: 73,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  // --- async/dont-block-start.json: root cause: FACT-SYNC ---
  {
    file: "async/dont-block-start.json",
    line: 3,
    reason:
      "PendingCapability: pending-capability: instantiation-time task " +
      "context — a core start function calls a *task*-scoped built-in " +
      "(not merely an instance-scoped one) during instantiation, where " +
      "no task exists. definitions.py reads `current_task()` (line 309) " +
      "and has no model for instantiation-time calls; instance-scoped " +
      "built-ins already avoid this by taking their instance from the " +
      "trampoline decl. Needs the instantiation-time task context the " +
      "spec implies but does not spell out",
  },
  // --- async/drop-cross-task-borrow.json: root cause: FACT-ASYNC ---
  {
    file: "async/drop-cross-task-borrow.json",
    line: 305,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  {
    file: "async/drop-cross-task-borrow.json",
    line: 307,
    reason:
      "same blocking capability as line 305, see that entry",
  },
  {
    file: "async/drop-cross-task-borrow.json",
    line: 309,
    reason:
      "same blocking capability as line 305, see that entry",
  },
  // --- async/drop-stream.json: root cause: STREAMS ---
  {
    file: "async/drop-stream.json",
    line: 158,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  {
    file: "async/drop-stream.json",
    line: 160,
    reason:
      "same blocking capability as line 158, see that entry",
  },
  // --- async/drop-subtask.json: root cause: FACT-ASYNC ---
  {
    file: "async/drop-subtask.json",
    line: 139,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  {
    file: "async/drop-subtask.json",
    line: 140,
    reason:
      "same blocking capability as line 139, see that entry",
  },
  // --- async/drop-waitable-set.json: root cause: FACT-ASYNC ---
  {
    file: "async/drop-waitable-set.json",
    line: 84,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  // --- async/empty-wait.json: root cause: FACT-ASYNC ---
  {
    file: "async/empty-wait.json",
    line: 199,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  // --- async/futures-must-write.json: root cause: STREAMS ---
  {
    file: "async/futures-must-write.json",
    line: 117,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  {
    file: "async/futures-must-write.json",
    line: 118,
    reason:
      "same blocking capability as line 117, see that entry",
  },
  // --- async/partial-stream-copies.json: root cause: STREAMS ---
  {
    file: "async/partial-stream-copies.json",
    line: 238,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  // --- async/passing-resources.json: root cause: STREAMS ---
  {
    file: "async/passing-resources.json",
    line: 175,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  {
    file: "async/passing-resources.json",
    line: 176,
    reason:
      "same blocking capability as line 175, see that entry",
  },
  // --- async/same-component-stream-future.json: root cause: STREAMS ---
  {
    file: "async/same-component-stream-future.json",
    line: 253,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  {
    file: "async/same-component-stream-future.json",
    line: 255,
    reason:
      "same blocking capability as line 253, see that entry",
  },
  {
    file: "async/same-component-stream-future.json",
    line: 257,
    reason:
      "same blocking capability as line 253, see that entry",
  },
  {
    file: "async/same-component-stream-future.json",
    line: 259,
    reason:
      "same blocking capability as line 253, see that entry",
  },
  // --- async/sync-barges-in.json: root cause: FACT-ASYNC ---
  {
    file: "async/sync-barges-in.json",
    line: 311,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  // --- async/sync-streams.json: root cause: STREAMS ---
  {
    file: "async/sync-streams.json",
    line: 208,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  // --- async/trap-if-block-and-sync.json: see entries ---
  {
    file: "async/trap-if-block-and-sync.json",
    line: 5,
    reason:
      "wasmparser pin drift (same class as binary.json:962/1194 and " +
      "attributes.json:30/213): `testgen` assembles the suite with `wast` " +
      "255.0.0 while `translator-shim` validates with `wasmparser` 0.252.0, " +
      "the version wasmtime-environ 47.0.3 links against. The 0.253-0.255 " +
      "window re-aritied the thread built-in opcodes: `0x2a` is " +
      "`ThreadUnsuspend` (no payload) in 0.252 but " +
      "`ThreadSuspendThenResume{cancellable}` (reads one byte) in 0.255. " +
      "This file's canonical section ends `... 2a 00 28 ...` at 0xc16; " +
      "0.252 stops after `2a`, misreads the `00` at 0xc17 as a new " +
      "canonical function (`0x00` = lift family), then rejects the `0x28` " +
      "at 0xc18 — the reported error, exactly. Not a plan.rs mapping bug: " +
      "the failure is in wasmparser's decoder, before any mapping runs. " +
      "Lifted by a wasmtime-environ whose wasmparser is >= the 0.255 line; " +
      "downgrading testgen to `wast` 252 is NOT a fix (verified: it fails " +
      "to parse 44 of the 59 suite files, which use the newer " +
      "`(memory (core memory ...))` text syntax). Note the file's canonical " +
      "functions are all deferred thread built-ins anyway (PLAN.md §16) " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 286,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 287,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 288,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 289,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 290,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 291,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 292,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 293,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 294,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 295,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 296,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 297,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 298,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 299,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 300,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 301,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 302,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 303,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 304,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 305,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 306,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 307,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 308,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 309,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 310,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 311,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 312,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 313,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 314,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 315,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 316,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 317,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 318,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 319,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 320,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 321,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 322,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 323,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 324,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 325,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 326,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 327,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 328,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 329,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 330,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 331,
    reason:
      "same blocking capability as line 5, see that entry",
  },
  // --- async/trap-if-done.json: root cause: STREAMS ---
  {
    file: "async/trap-if-done.json",
    line: 446,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  {
    file: "async/trap-if-done.json",
    line: 448,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 450,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 452,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 454,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 456,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 458,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 460,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 462,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 464,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 466,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 468,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  {
    file: "async/trap-if-done.json",
    line: 470,
    reason:
      "same blocking capability as line 446, see that entry",
  },
  // --- async/trap-if-sync-and-waitable-set.json: root cause: FACT-ASYNC ---
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 281,
    reason:
      "pending-capability: FACT cross-component async calls (M2 phase " +
      "2) — the component's adapters import `async-start-call` / " +
      "`async-return-call`, wasmtime's FACT intrinsics for calling an " +
      "async-lifted export from another *component* (as opposed to " +
      "from the host, which this phase implements). Instantiation is " +
      "declined, so every command against the instance follows",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 283,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 285,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 287,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 289,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 291,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 293,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 295,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 297,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 299,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 301,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 303,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 305,
    reason:
      "same blocking capability as line 281, see that entry",
  },
  // --- async/trap-if-transfer-in-waitable-set.json: root cause: STREAMS ---
  {
    file: "async/trap-if-transfer-in-waitable-set.json",
    line: 49,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  {
    file: "async/trap-if-transfer-in-waitable-set.json",
    line: 51,
    reason:
      "same blocking capability as line 49, see that entry",
  },
  // --- async/wait-during-callback.json: root cause: STREAMS ---
  {
    file: "async/wait-during-callback.json",
    line: 77,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
  // --- async/zero-length.json: root cause: STREAMS ---
  {
    file: "async/zero-length.json",
    line: 223,
    reason:
      "pending-capability: streams (M2 phase 2) — the component uses " +
      "stream/future built-ins, which are wired as " +
      "deferred-capability trampolines until the copy machinery lands",
  },
];

export function isXfail(file: string, line: number): boolean {
  return XFAIL.some((e) => e.file === file && e.line === line);
}
