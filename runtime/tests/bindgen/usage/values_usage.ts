// Hand-written usage sample for the generated `values.ts` facade — exercises
// every host-value shape mapping (records, variants, enums, flags, options,
// results, tuples, lists) against the generated types, at `deno check` time.

import { bind } from "../generated/values.ts";
import type {
  Color,
  Mixed,
  Perms,
  Shape,
  ValuesExports,
} from "../generated/values.ts";
import type { ComponentHandle } from "../../../src/exec/mod.ts";

export function useValues(handle: ComponentHandle) {
  const exports: ValuesExports = bind(handle);

  const b: boolean = exports["echo-bool"](true);
  const u: bigint = exports["echo-u64"](18446744073709551615n);
  const s: bigint = exports["echo-s64"](-1n);
  const f32: number = exports["echo-f32"](1.5);
  const f64: number = exports["echo-f64"](1.5);
  const ch: string = exports["echo-char"]("x");
  const str: string = exports["echo-string"]("hi");

  const mixed: Mixed = { a: 1, b: "x", c: 1.5, d: true };
  const mixedOut: Mixed = exports["echo-record"](mixed);

  const shape: Shape = { circle: 1.5 };
  const shapeOut: Shape = exports["echo-variant"](shape);
  const shapePoint: Shape = { point: null };

  const color: Color = { red: null };
  const colorOut: Color = exports["echo-enum"](color);

  const perms: Perms = { read: true, write: false, exec: false, admin: true };
  const permsOut: Perms = exports["echo-flags"](perms);

  // option<string> — current interpreter shape: single-key variant object.
  const some: { some: string } | { none: null } = exports["echo-option"](
    { some: "x" },
  );
  const none: { some: string } | { none: null } = exports["echo-option"](
    { none: null },
  );

  // option<option<u32>> nests the same shape one level deeper.
  const nested = exports["echo-option-nested"]({ some: { some: 1 } });

  // result<u32, string> — {ok}/{error}.
  const ok: { ok: number } | { error: string } = exports["echo-result"](
    { ok: 1 },
  );
  const err: { ok: number } | { error: string } = exports["echo-result"](
    { error: "boom" },
  );

  const bytes: Uint8Array = exports["echo-list-u8"](new Uint8Array([1, 2, 3]));
  const strings: Array<string> = exports["echo-list-string"](["a", "b"]);

  // tuple<u32,string,f64> — despecialized record shape `{0,1,2}`.
  const tuple: { 0: number; 1: string; 2: number } = exports["echo-tuple"](
    { 0: 1, 1: "x", 2: 1.5 },
  );

  return {
    b,
    u,
    s,
    f32,
    f64,
    ch,
    str,
    mixedOut,
    shapeOut,
    shapePoint,
    colorOut,
    permsOut,
    some,
    none,
    nested,
    ok,
    err,
    bytes,
    strings,
    tuple,
  };
}
