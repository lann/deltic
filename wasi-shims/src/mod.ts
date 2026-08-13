// wasi-shims — the minimal WASI shim package (contracts/embedder-api.md
// C2 checklist item 7): the executable check that the embedder conventions
// (`@deltic/runtime/embedder`) serve WASI. Scope: p2 baseline +
// p3 clocks (mission scope; wasi:http deferred). p3 sockets UDP is à la
// carte at `@deltic/wasi-shims/sockets` (issue #4; Deno-native hosts
// only) — deliberately not merged here: this root module stays
// host-agnostic web-platform code, and `wasiShims()` never grows a
// fragment whose honest answer on most hosts is `not-supported`.
//
// `wasiShims(options)` returns one flat imports-record fragment, keyed by
// compatibility-**track** keys per contracts/embedder-api.md §"Version
// canonicalization" (`@0.2`, `@0.3`) — this package is the flagship
// track-key-registration consumer: one `@0.2` provider serves every p2
// leaf regardless of whether the guest's binary says `0.2.6`, `0.2.9` or
// `0.2.12` (C0 finding D-2), and one `@0.3` union provider serves both
// divergent `monotonic-clock@0.3.0` drafts the corpus actually links
// (C0 finding D-1).

import { cli, type CliCaptured, type CliOptions } from "./cli.ts";
import { clocks, type ClocksOptions } from "./clocks.ts";
import { filesystem } from "./filesystem.ts";
import { io } from "./io.ts";
import { random, type RandomOptions } from "./random.ts";

export {
  cli,
  type CliCaptured,
  type CliOptions,
  type CliResult,
  ExitError,
  TerminalInput,
  TerminalOutput,
} from "./cli.ts";
export {
  clocks,
  type ClocksOptions,
} from "./clocks.ts";
export {
  Descriptor,
  DirectoryEntryStream,
  filesystem,
} from "./filesystem.ts";
export {
  InputStream,
  io,
  IoError,
  OutputStream,
  poll,
  Pollable,
  type StreamErrorValue,
} from "./io.ts";
export {
  random,
  type RandomOptions,
} from "./random.ts";

export interface WasiShimsOptions {
  cli?: CliOptions;
  clocks?: ClocksOptions;
  random?: RandomOptions;
}

/**
 * The merged imports record plus the one piece of host-observable state a
 * caller needs back out (contract wording: "expose captured output on the
 * returned handle"). `captured` is a plain extra property, not a WIT
 * interface-id key, so it never participates in `ImportResolver`'s
 * track/exact matching (`parseInterfaceId("captured")` has no `@`, and it is
 * excluded from the unversioned-track bookkeeping because it contains
 * neither `:` nor `/` — see `runtime/src/embedder/version.ts`
 * `#register`).
 */
export interface WasiShims extends Record<string, unknown> {
  readonly captured: CliCaptured;
}

/**
 * Build the merged `wasi:*` imports fragment for `instantiate`.
 *
 * Usage: `instantiate(artifacts, { ...wasiShims(), ...moreImports })`.
 */
export function wasiShims(options: WasiShimsOptions = {}): WasiShims {
  const c = cli(options.cli);
  const merged: Record<string, unknown> = {
    ...c.imports,
    ...io().imports,
    ...clocks(options.clocks).imports,
    ...random(options.random).imports,
    ...filesystem().imports,
  };
  return Object.assign(merged, { captured: c.captured }) as WasiShims;
}
