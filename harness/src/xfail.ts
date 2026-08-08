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
];

export function isXfail(file: string, line: number): boolean {
  return XFAIL.some((e) => e.file === file && e.line === line);
}
