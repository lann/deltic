// WIT label -> JS identifier casing, and the mangled export/import leaf
// grammar that carries resource membership.
//
// Governing contract: contracts/embedder-api.md §"Naming and casing".
// Casing applies to *identifiers* only — function/method/static names, record
// fields, flag names, resource class names. It NEVER applies to data: enum
// values, variant/result case tags and interface ids stay kebab-case verbatim.

/**
 * `get-resolution` -> `getResolution`.
 *
 * The rule, stated exactly: split the label on `-`; the first fragment is
 * unchanged; every later fragment has its first character upper-cased and its
 * remainder preserved. Preserving the remainder is what keeps acronym
 * fragments intact — `outgoing-HTTP-request` -> `outgoingHTTPRequest` — which
 * a naive `toLowerCase()` of the tail would destroy.
 *
 * WIT labels are already lower-kebab in practice, so the first fragment needs
 * no adjustment; nothing here lower-cases anything.
 */
export function camelCase(label: string): string {
  const parts = label.split("-");
  return parts[0] + parts.slice(1).map(upperFirst).join("");
}

/** `tcp-socket` -> `TcpSocket` (resource class names). */
export function pascalCase(label: string): string {
  return label.split("-").map(upperFirst).join("");
}

function upperFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * A leaf name in `plan.exports` / `plan.imports`, decoded.
 *
 * The Component Model mangles resource membership into the name itself
 * (`[constructor]counter`, `[method]counter.increment`,
 * `[static]counter.merge`); C0 finding #2 was embedders hand-transcribing
 * these. Assembling and disassembling them is a runtime obligation.
 */
export type LeafName =
  | { form: "plain"; name: string }
  | { form: "constructor"; resource: string }
  | { form: "method"; resource: string; member: string }
  | { form: "static"; resource: string; member: string };

const MANGLED = /^\[([a-z-]+)\](.*)$/;

/** Decode a mangled leaf name; unmangled names come back as `plain`. */
export function parseLeafName(raw: string): LeafName {
  const m = MANGLED.exec(raw);
  if (m === null) return { form: "plain", name: raw };
  const [, tag, rest] = m;
  switch (tag) {
    case "constructor":
      return { form: "constructor", resource: rest };
    case "method":
    case "static": {
      const dot = rest.indexOf(".");
      if (dot < 0) break;
      return {
        form: tag,
        resource: rest.slice(0, dot),
        member: rest.slice(dot + 1),
      };
    }
  }
  // Unknown bracket forms (`[async]`, `[dtor]`, future spellings) are left
  // alone rather than guessed at: they surface verbatim, which is loud.
  return { form: "plain", name: raw };
}
