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
  {
    file: "values/post-return.json",
    line: 260,
    reason:
      "translator error [unsupported]: CoreDef::UnsafeIntrinsic" +
      "(ContextGetI32_0) encountered — crates/translator-shim + " +
      "contracts/plan-format.md gap " +
      "(pending-capability: M2 context.get/set in plan)",
  },
  {
    file: "values/post-return.json",
    line: 292,
    reason: "same UnsafeIntrinsic gap as line 260, see that entry",
  },
  {
    file: "values/post-return.json",
    line: 293,
    reason: "same UnsafeIntrinsic gap as line 260, see that entry",
  },
  // post-return.wast:334 calls `backpressure.inc`/`backpressure.dec` from a
  // post-return function. NOTE the observed symptom is a *wrong value*
  // ("expected u32 11, got 5"), not an error: the module command fails as a
  // capability skip and the invoke then runs against the previously
  // instantiated component, which also exports `f`. The value mismatch is an
  // artifact of that, not a canonical-ABI bug.
  {
    file: "values/post-return.json",
    line: 358,
    reason:
      "UnsupportedFeatureError: component requires host trampoline " +
      "'backpressure-inc' — runtime/src/intrinsics gap " +
      "(pending-capability: M2 task core)",
  },
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
];

export function isXfail(file: string, line: number): boolean {
  return XFAIL.some((e) => e.file === file && e.line === line);
}
