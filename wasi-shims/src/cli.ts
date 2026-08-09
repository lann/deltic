// `wasi:cli@0.2` — environment, exit, stdin, stdout, stderr, terminal-*
// (contracts/embedder-api.md §"WASI examination"; leaf inventory mined from
// `iroh_exec_model_guest.wasm` / `engine-go/main.wasm`, tools/smoke-c0/
// REPORT.md §"C1 design-input notes" finding provenance).

import { InputStream, OutputStream } from "./io.ts";

/** Raised by `exit()` when `throwOnExit` is set (contract: "option to throw a named ExitError"). */
export class ExitError extends Error {
  constructor(readonly ok: boolean) {
    super(`wasi:cli/exit#exit(${ok ? "success" : "failure"})`);
    this.name = "ExitError";
  }
}

/** `terminal-input`/`terminal-output` are opaque resources; never produced (no terminal). */
export class TerminalInput {}
export class TerminalOutput {}

export interface CliOptions {
  /** `get-arguments`; default `[]`. */
  args?: string[];
  /** `get-environment`; default `{}`. */
  env?: Record<string, string>;
  /** `initial-cwd`; default `undefined` (none). */
  cwd?: string;
  /** `get-stdin`'s buffer contents; default empty (matches contract: "stdin (empty)"). */
  stdinBuffer?: Uint8Array;
  /** Also `console.log`/`console.error` captured stdout/stderr writes. Default false. */
  passthrough?: boolean;
  /** `exit()` throws `ExitError` instead of merely recording. Default false. */
  throwOnExit?: boolean;
}

/** Captured host-observable state exposed on the returned handle (contract wording). */
export interface CliCaptured {
  stdout(): Uint8Array;
  stderr(): Uint8Array;
  stdoutText(): string;
  stderrText(): string;
  /** Whether `wasi:cli/exit#exit` has been called. */
  exited(): boolean;
  /** The `result` tag of the last `exit()` call's `status`, or `undefined` if never called. */
  exitOk(): boolean | undefined;
}

export interface CliResult {
  imports: Record<string, unknown>;
  captured: CliCaptured;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * `wasi:cli@0.2` provider fragment (track key).
 *
 * `exit`'s WIT signature is `exit: func(status: result)` — `result` with no
 * type parameters, i.e. `result<_, _>`. Per contracts/embedder-api.md's value
 * table, a `result` in **parameter** (non-return) position is plain nested
 * data: `{ tag: "ok" } | { tag: "err" }`, never a throw. Only a function's own
 * *return*-position result throws/rejects.
 */
export function cli(options: CliOptions = {}): CliResult {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const passthrough = options.passthrough ?? false;
  let exited = false;
  let exitOk: boolean | undefined;

  const stdout = new OutputStream((chunk) => {
    stdoutChunks.push(chunk);
    if (passthrough) console.log(new TextDecoder().decode(chunk));
  });
  const stderr = new OutputStream((chunk) => {
    stderrChunks.push(chunk);
    if (passthrough) console.error(new TextDecoder().decode(chunk));
  });

  const captured: CliCaptured = {
    stdout: () => concat(stdoutChunks),
    stderr: () => concat(stderrChunks),
    stdoutText: () => new TextDecoder().decode(concat(stdoutChunks)),
    stderrText: () => new TextDecoder().decode(concat(stderrChunks)),
    exited: () => exited,
    exitOk: () => exitOk,
  };

  const imports: Record<string, unknown> = {
    "wasi:cli/environment@0.2": {
      getEnvironment: (): [string, string][] => Object.entries(options.env ?? {}),
      getArguments: (): string[] => options.args ?? [],
      initialCwd: (): string | undefined => options.cwd,
    },
    "wasi:cli/exit@0.2": {
      exit: (status: { tag: "ok" | "err" }): void => {
        exited = true;
        exitOk = status.tag === "ok";
        if (options.throwOnExit) throw new ExitError(exitOk);
      },
    },
    "wasi:cli/stdin@0.2": {
      getStdin: (): InputStream => new InputStream(options.stdinBuffer),
    },
    "wasi:cli/stdout@0.2": { getStdout: (): OutputStream => stdout },
    "wasi:cli/stderr@0.2": { getStderr: (): OutputStream => stderr },
    "wasi:cli/terminal-input@0.2": { TerminalInput },
    "wasi:cli/terminal-output@0.2": { TerminalOutput },
    // No terminal is ever attached; `option<terminal-*>` collapses to the
    // outermost-option rule (contract §"Value mapping"): `undefined` = none.
    "wasi:cli/terminal-stdin@0.2": {
      getTerminalStdin: (): TerminalInput | undefined => undefined,
    },
    "wasi:cli/terminal-stdout@0.2": {
      getTerminalStdout: (): TerminalOutput | undefined => undefined,
    },
    "wasi:cli/terminal-stderr@0.2": {
      getTerminalStderr: (): TerminalOutput | undefined => undefined,
    },
  };

  return { imports, captured };
}
