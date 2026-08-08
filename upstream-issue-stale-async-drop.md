# Upstream issue draft: stale `$async?` on `canon resource.drop` in CanonicalABI.md

Target repo: WebAssembly/component-model
Status: not yet filed

---

Title: **CanonicalABI.md: leftover `$async?` immediate on `canon resource.drop`**

#578 removed the `async` immediate from `resource.drop` (Explainer grammar,
Binary.md opcode `0x07`, and the `option<subtask>` prose), but one wat template
in CanonicalABI.md's validation section still has it:

https://github.com/WebAssembly/component-model/blob/73b7ad5/design/mvp/CanonicalABI.md#L4013

```wat
(canon resource.drop $rt $async? (core func $f))
```

Everything else agrees the immediate is gone:

- Explainer.md grammar: `(canon resource.drop <typeidx> (core func <id>?))`
- Binary.md: only `0x03` (the `0x07` async encoding was removed in #578)
- canonical-abi/definitions.py: `canon_resource_drop(rt, i)` — no async param

Fix is deleting the one token. Note the `$async?` immediates on
`stream.cancel-read/write` / `future.cancel-read/write` a few sections down
(~L4744-4747) are still correct and should be left alone.

---

Filing notes (not part of the issue body):

- Removal rationale: #578 made `async` a checked effect on the function type;
  dtor calls are non-`async`-lowered/typed, so the drop can never observe
  blocking and the `option<subtask>` return lost its meaning.
- #646 subsequently forbade async ABI options on sync-typed functions
  entirely; current dtor text ("may not block; may spawn a cooperative thread
  that does") dates from there.
- Verified at HEAD `73b7ad5` (2026-08-08).
