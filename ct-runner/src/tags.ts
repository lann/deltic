// Feature-tag scheduling (issue #25): the L0 tags inventory and the
// applicability rule, ported from polymorph-test's authorities —
//
//   - Section format: crates/component-test-formats/src/inventory.rs
//     (`collect_tags_sections` / `parse_tags_records`): newline-delimited
//     `name tag...` text records in `component-test:tags@0.1` custom
//     sections, collected from the component AND nested modules/components
//     (their reader uses wasmparser's `parse_all`, which descends; the
//     SDK's `#[link_section]` puts the records in the guest CORE module,
//     and those survive wac composition — verified empirically on the
//     polymorph-tls composed suites). Records are newline-delimited within
//     a section; a producer may omit the final newline, so a newline is
//     repaired per section before concatenation, exactly as upstream does.
//   - Record forms: `name tag...` (exact) and `prefix/* tag...` (generated
//     rows: leaves are enumerated at run time below the prefix).
//   - Applicability: crates/component-test-core/src/tags.rs — `feature`
//     requires the target to HAVE the feature, `!feature` requires it to
//     LACK it; a case applies iff every mark is satisfied against the
//     runner's missing-features list. js/viewer/harness.mjs `applies()` is
//     the JS-leg reference this mirrors.
//   - Drift policy: harness.mjs `runCases` — an enumerated case that no
//     record covers throws (the run is unsound, not failing).

/**
 * The custom-section name (component-test-core `name::TAGS_SECTION`).
 *
 * @internal — test-only export; wired automatically by `runSuite()`'s tag
 * scheduling, the public entry point.
 */
export const TAGS_SECTION = "component-test:tags@0.1";

/**
 * Parsed static inventory: exact case records + generated-row prefixes.
 *
 * @internal — an internal shape passed between this module's own
 * functions and `run-suite.ts`; not part of `runSuite()`'s public
 * options/return shape.
 */
export interface TagsInventory {
  exact: Map<string, string[]>;
  prefixes: Array<{ prefix: string; tags: string[] }>;
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"

function hasWasmMagic(bytes: Uint8Array, at = 0): boolean {
  return bytes.length >= at + 8 && MAGIC.every((b, i) => bytes[at + i] === b);
}

/** u32 LEB128 at `pos`; returns [value, nextPos]. Traps on overlong/EOF. */
function lebU32(bytes: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= bytes.length) throw new Error("tags scan: truncated LEB128");
    const b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift >= 35) throw new Error("tags scan: LEB128 too long for u32");
  }
  return [result >>> 0, pos];
}

/**
 * Collect the concatenated bytes of every `component-test:tags@0.1` custom
 * section in `bytes` — the component's own sections plus those of nested
 * core modules (section id 1) and nested components (section id 4), which
 * both embed complete wasm binaries. Returns null when no section exists
 * anywhere (a suite not built with their SDK).
 *
 * @internal — used only by `loadTagsInventory()` and this package's own
 * tests; the public entry point is `runSuite()`, which schedules tag
 * gating automatically.
 */
export function collectTagsSections(bytes: Uint8Array): Uint8Array | null {
  if (!hasWasmMagic(bytes)) throw new Error("tags scan: not a wasm binary");
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const NL = new Uint8Array([0x0a]);

  const scan = (buf: Uint8Array, core: boolean) => {
    let pos = 8; // magic + version/layer
    while (pos < buf.length) {
      const id = buf[pos++];
      const [size, afterSize] = lebU32(buf, pos);
      pos = afterSize;
      const end = pos + size;
      if (end > buf.length) throw new Error("tags scan: truncated section");
      if (id === 0) {
        const [nameLen, afterName] = lebU32(buf, pos);
        const nameEnd = afterName + nameLen;
        if (nameEnd > end) throw new Error("tags scan: truncated custom name");
        if (decoder.decode(buf.subarray(afterName, nameEnd)) === TAGS_SECTION) {
          const data = buf.subarray(nameEnd, end);
          chunks.push(data);
          // Newline repair per section (inventory.rs: nothing guarantees a
          // producer terminates its last record).
          if (data.length === 0 || data[data.length - 1] !== 0x0a) {
            chunks.push(NL);
          }
        }
      } else if (!core && (id === 1 || id === 4)) {
        // 1 = core module, 4 = nested component: payload is a full binary.
        const payload = buf.subarray(pos, end);
        if (hasWasmMagic(payload)) scan(payload, id === 1);
      }
      pos = end;
    }
  };

  scan(bytes, false);
  if (chunks.length === 0) return null;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Parse concatenated records (inventory.rs `parse_tags_records`): one
 * record per line, `name tag...`, blank lines skipped, duplicate names and
 * empty tags rejected. Grammar validation beyond that (WIT-label checks)
 * is the producer's job — their SDK validates at macro-expansion time.
 *
 * @internal — used only by `loadTagsInventory()` and this package's own
 * tests; the public entry point is `runSuite()`.
 */
export function parseTagsRecords(bytes: Uint8Array): TagsInventory {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const inv: TagsInventory = { exact: new Map(), prefixes: [] };
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split(" ").filter((p) => p !== "");
    const name = parts[0];
    const tags = parts.slice(1);
    for (const t of tags) {
      if (t === "" || t === "!") {
        throw new Error(`tags section: empty mark on \`${name}\``);
      }
    }
    if (seen.has(name)) {
      throw new Error(`tags section: duplicate record \`${name}\``);
    }
    seen.add(name);
    const prefix = name.endsWith("/*") ? name.slice(0, -2) : null;
    if (prefix !== null) {
      inv.prefixes.push({ prefix, tags });
    } else {
      inv.exact.set(name, tags);
    }
  }
  return inv;
}

/**
 * Convenience: scan + parse; null when the suite carries no inventory.
 *
 * @internal — used only by `run-suite.ts`'s automatic tag scheduling and
 * this package's own tests; the public entry point is `runSuite()`.
 */
export function loadTagsInventory(bytes: Uint8Array): TagsInventory | null {
  const sections = collectTagsSections(bytes);
  return sections === null ? null : parseTagsRecords(sections);
}

/** The tags covering `name`: exact record, else a generated-row prefix
 * record (leaves live below `prefix/`), else undefined (inventory drift).
 *
 * @internal — used only by `run-suite.ts`'s per-case scheduling and this
 * package's own tests; the public entry point is `runSuite()`. */
export function tagsOf(inv: TagsInventory, name: string): string[] | undefined {
  const exact = inv.exact.get(name);
  if (exact !== undefined) return exact;
  for (const { prefix, tags } of inv.prefixes) {
    if (name.startsWith(prefix + "/")) return tags;
  }
  return undefined;
}

/** harness.mjs `applies()`: `!f` needs f missing; `f` needs f present.
 *
 * @internal — used only by `run-suite.ts`'s scheduling and this package's
 * own tests; the public entry point is `runSuite()`. */
export function applies(tags: string[], missing: string[]): boolean {
  return tags.every((t) =>
    t.startsWith("!") ? missing.includes(t.slice(1)) : !missing.includes(t)
  );
}

/** The N/A row's `detail`: the first unsatisfied mark (harness.mjs's
 * `excluding`), empty string if somehow none (mirrors `excluding ?? ""`).
 *
 * @internal — used only by `run-suite.ts`'s scheduling and this package's
 * own tests; the public entry point is `runSuite()`. */
export function firstExcluding(tags: string[], missing: string[]): string {
  return tags.find((t) =>
    t.startsWith("!") ? !missing.includes(t.slice(1)) : missing.includes(t)
  ) ?? "";
}
