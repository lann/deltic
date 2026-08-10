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
  // --- values/post-return.json: post-return.wast:4 ($Tester) declares
  // every async built-in (task.return, thread.yield/INDEX, waitable-set.*,
  // subtask.*, stream.*, future.*) to assert they trap from a post-return
  // function. The M2 task core shipped; the SURVIVING refusal is
  // 'thread-index' — the 🧵 shared-everything-threads class, deferred by
  // https://github.com/lann/deltic/issues/12 — so the component still declines at instantiation and all 28
  // assert_traps cascade off 'no current instance'. (Reason strings
  // rewritten post-M2-exit-review: they previously named the shipped task
  // core, which would misdirect triage.)
  {
    file: "values/post-return.json",
    line: 202,
    reason:
      "UnsupportedFeatureError: component requires host trampoline " +
      "'thread-index' — post-return.wast:4 declares the full async built-in " +
      "surface incl. 🧵 thread.* built-ins; deferred-threads class, https://github.com/lann/deltic/issues/12 " +
      "(pending-capability: shared-everything threads)",
  },
  {
    file: "values/post-return.json",
    line: 204,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 206,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 208,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 210,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 212,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 214,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 216,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 218,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 220,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 222,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 224,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 226,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 228,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 230,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 232,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 234,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 236,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 238,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 240,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 242,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 244,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 246,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 248,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 250,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 252,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 254,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 256,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/lann/deltic/issues/12) dependency as line 202",
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
  // --- values/variants.json: variants.wast:83's component mixes an
  // async-lifted export (`mix-ret`) with sync ones, reached through FACT
  // adapters. The component instantiates and its sync exports run (M2 phase 2b
  // landed prepare-call / {sync,async}-start-call), so only the one command
  // below still fails — pinned by
  // runtime/tests/integration/e2e_suite_test.ts ("async-lifted exports
  // instantiate and run"). ---

  // =====================================================================
  // async/ — triage as of M2 phase 2c (streams/futures/error-context).
  //
  // Streams, futures and error-context are IMPLEMENTED; the entries below no
  // longer describe a missing value type. The dominant remaining class is
  // JSPI: the *synchronous* form of a stream/future copy, of
  // `waitable-set.wait`, and of a cross-component call all block the calling
  // wasm frame, which a stackless runtime cannot do. See
  // runtime/src/intrinsics/stream_builtins.ts `finishCopy`.
  //
  // Historic note (M2 phase 1 triage) follows.
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
  // --- async/async-calls-sync.json: GREEN under jspi auto-detection (M2
  // flip); entries pruned. ---
  // --- async/big-interleaving-test.json: GREEN under jspi auto-detection
  // (M2 flip); entry pruned. ---
  // --- async/builtin-trap-poisons-instance.json: root cause: STREAMS ---
  // --- async/cancel-stream.json: root cause: STREAMS ---
  // --- async/cancel-subtask.json: GREEN under jspi auto-detection (M2
  // flip); entry pruned. ---
  // --- async/cancellable.json: GREEN under jspi auto-detection (M2 flip:
  // request_cancellation now finds cancellable SuspensionPoints, and the
  // async subtask.cancel waits for callee determinacy); entry pruned. ---
  // --- async/closed-stream.json: root cause: STREAMS ---
  // --- async/cross-abi-calls.json: root cause: FACT-ASYNC ---
  // --- async/cross-task-future.json: root cause: STREAMS ---
  // --- async/deadlock.json: GREEN under jspi auto-detection (M2 flip: the
  // driver's deadlock verdict now fires with wasmtime's trap text); entry
  // pruned. ---
  // --- async/dont-block-start.json: GREEN under jspi auto-detection (M2
  // flip: a start-function SuspendError maps to "cannot block a synchronous
  // task before returning"); entry pruned. ---
  // --- async/drop-cross-task-borrow.json: root cause: FACT-ASYNC ---
  // lines 305/307 GREEN after the #18 tls-smoke fixes (FACT [async-start]
  // borrow window + ResourceTypeInfo unification); entries pruned.
  {
    file: "async/drop-cross-task-borrow.json",
    line: 309,
    reason:
      "observed: AssertionError: transfer-borrow outside an " +
      "enter-sync-call/exit-sync-call bracket",
  },
  // --- async/drop-stream.json: root cause: STREAMS ---
  {
    file: "async/drop-stream.json",
    line: 158,
    reason:
      "observed: Error: expected trap \"cannot remove busy " +
      "stream\", got \"cannot drop busy stream\"",
  },
  // --- async/drop-subtask.json: GREEN under jspi auto-detection (M2 flip);
  // entry pruned. ---
  // --- async/drop-waitable-set.json: root cause: FACT-ASYNC ---
  // --- async/empty-wait.json: GREEN under jspi auto-detection (M2 flip);
  // entry pruned. ---
  // --- async/futures-must-write.json: root cause: STREAMS ---
  // --- async/partial-stream-copies.json: GREEN under jspi auto-detection
  // (M2 flip); entry pruned. ---
  // --- async/passing-resources.json: lines 175/176 GREEN after the #18
  // tls-smoke fixes (cycle-safe structural ValType equality + token
  // unification); entries pruned. ---
  // --- async/same-component-stream-future.json: root cause: STREAMS ---
  // --- async/sync-barges-in.json: GREEN under jspi auto-detection (M2
  // flip); entry pruned. ---
  // --- async/sync-streams.json: GREEN. Since #43 deltic implements
  // wasmtime's model: the entry gate is HELD for the whole core invocation
  // (a resolved producer blocked mid-sync-write keeps gating), and the
  // async-lowered call's initial status is decided only after the callee
  // instance's runnable work has been drained to quiescence — by which time
  // the producer has exited and the next task reports STARTED. Adjudicated
  // 2026-08-10 (issue #43): the test's hard STARTED assertion is
  // schedule-dependent — an upstream test defect overfitting wasmtime's
  // deferred-entry policy (pristine definitions.py answers STARTING) —
  // and deltic's drain policy satisfies it as written under any seed. The
  // former release-at-BLOCK divergence is gone. (Before the M2 jspi flip
  // this file was xfailed outright.)
  // entry pruned. ---
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
      "functions are all deferred thread built-ins anyway (https://github.com/lann/deltic/issues/12) " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 286,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 287,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 288,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 289,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 290,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 291,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 292,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 293,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 294,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 295,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 296,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 297,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 298,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 299,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 300,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 301,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 302,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 303,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 304,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 305,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 306,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 307,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 308,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 309,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 310,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 311,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 312,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 313,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 314,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 315,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 316,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 317,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 318,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 319,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 320,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 321,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 322,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 323,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 324,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 325,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 326,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 327,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 328,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 329,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 330,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 331,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  // --- async/trap-if-done.json: root cause: STREAMS ---
  // --- async/trap-if-sync-and-waitable-set.json: root cause: FACT-ASYNC ---
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 281,
    reason:
      "cascade: this file's component was declined earlier, so " +
      "every later command against the instance fails; see the " +
      "first entry for this file",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 283,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 285,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 287,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 289,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 291,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 293,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 295,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 297,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 299,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 301,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 303,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 305,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  // --- async/trap-if-transfer-in-waitable-set.json: root cause: STREAMS ---
  // --- async/wait-during-callback.json: root cause: STREAMS ---
  // --- async/zero-length.json: GREEN under jspi auto-detection (M2 flip);
  // entry pruned. ---
];

export function isXfail(file: string, line: number): boolean {
  return XFAIL.some((e) => e.file === file && e.line === line);
}
