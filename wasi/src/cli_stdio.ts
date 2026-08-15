// `@deltic/wasi/cli-stdio` — the HOST-STDIO impl of `wasi:cli` (both the
// `@0.2` and `@0.3` tracks), à la carte: it grants access to the host
// process's stdin/stdout/stderr, environment, and arguments, so it never
// rides the default `wasi()` merge (which carries the capture impl,
// cli.ts). Compose it over the batteries:
//
//   instantiate(a, { ...wasi(), ...cliStdio().imports })
//
// Defaults come from `globalThis.process` (real Node, and Deno through
// its stable node compat — the same node-builtins-everywhere stance as
// sockets_platform.ts); every source and sink is injectable for
// virtualization and tests. On a host with no `process` and no
// injection, construction fails loudly — the capture impl is the honest
// browser answer.
//
// THE JSPI DEPENDENCE (the reason this impl exists as its own fragment):
// p2's `blocking-read` / `blocking-write-and-flush` / `blocking-flush`
// are SYNC WIT functions. Against capture buffers they degenerate to
// their non-blocking forms (io.ts base classes, sync fast path); against
// a REAL stdin/stdout they must genuinely wait, which parks the calling
// wasm frame through the suspending kernel (embedder-api A1/A2/A14 —
// io.ts marks the blocking declarations on the REGISTERED stream
// prototypes; these duck-typed stream impls override the behavior, and
// per A2 the mark relays). Consequences: guests linking the blocking
// leaves auto-select jspi mode on V8 engines, and on engines without
// JSPI a genuine wait raises a clean `NeedsJspi` at the park site. The
// `@0.3` track has no such dependence — its stdio is stream-shaped and
// async by construction (`read-via-stream` returns the tcp-receive
// tuple; `write-via-stream`'s promise is the future source, A12).
//
// Semantics:
//
//   * p2 stdin: reads serve synchronously from an internal buffer fed by
//     the source; `read` on an empty open stream returns an empty list
//     (p2's non-blocking contract), `blocking-read` parks until bytes or
//     EOF, and EOF-with-drained-buffer is the `closed` stream-error. The
//     feed pauses past a high-water mark (no unbounded buffering).
//   * p2 stdout/stderr: writes enqueue against a byte BUDGET
//     (`check-write` reports the remaining permit; exceeding it is the
//     guest's contract violation and traps via unbranded throw);
//     `blocking-flush`/`blocking-write-and-flush` park until the sink
//     drained everything; `subscribe` wakes when budget frees.
//   * exit: throws the branded `ExitError` (the embedder decides what
//     process-level exit means; `exitProcess: true` opts into a REAL
//     `process.exit`). `exit-with-code` (0.3) records the code on the
//     error.
//   * terminals: reported from the real streams' `isTTY` (injectable).
//   * environment/arguments/cwd: the host process's, overridable.

import { ComponentException, Stream, suspending } from "@deltic/runtime/embedder";
import {
  type CliByteSource,
  type CliErrorCode,
  type CliIoResult,
  ExitError,
  TerminalInput,
  TerminalOutput,
} from "./cli.ts";
import { IoError, Pollable } from "./io.ts";

const OK: CliIoResult = { kind: "ok" };

/** p2 stream-error `closed`, branded. */
function closedError(): ComponentException<{ kind: "closed" }> {
  return new ComponentException({ kind: "closed" });
}

function ioErrorCode(e: unknown): CliErrorCode {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return { kind: m.includes("epipe") || m.includes("broken pipe") ? "pipe" : "io" };
}

/** An async byte sink; the returned promise settling = the chunk drained. */
export type ByteSink = (chunk: Uint8Array) => void | Promise<void>;

export interface CliStdioOptions {
  /** stdin bytes; default: the host process's stdin. */
  stdin?: AsyncIterable<Uint8Array>;
  /** stdout sink; default: the host process's stdout. */
  stdout?: ByteSink;
  /** stderr sink; default: the host process's stderr. */
  stderr?: ByteSink;
  /** Terminal-ness per stream; default: the real streams' `isTTY`. */
  isTty?: { stdin?: boolean; stdout?: boolean; stderr?: boolean };
  /** `get-arguments`; default: the host process's argv (script-relative). */
  args?: string[];
  /** `get-environment`; default: the host process's env. */
  env?: Record<string, string>;
  /** `initial-cwd`/`get-initial-cwd`; default: the host process's cwd. */
  cwd?: string;
  /** `exit` terminates the host process instead of throwing `ExitError`. */
  exitProcess?: boolean;
}

export interface CliStdio {
  imports: Record<string, unknown>;
}

/** How many buffered stdin bytes pause the feed (and the p2 write budget). */
export const STDIO_HIGH_WATER = 65536;

// --- the host-process defaults (structural; node-builtins-everywhere) ---------

interface NodeProcessStream {
  isTTY?: boolean;
  write(chunk: Uint8Array, cb: (err?: Error | null) => void): boolean;
  once(event: string, listener: () => void): unknown;
}

interface NodeProcess {
  stdin?: AsyncIterable<Uint8Array> & { isTTY?: boolean };
  stdout?: NodeProcessStream;
  stderr?: NodeProcessStream;
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  exit?: (code: number) => never;
}

function hostProcess(): NodeProcess | undefined {
  const proc = (globalThis as { process?: unknown }).process;
  return typeof proc === "object" && proc !== null ? (proc as NodeProcess) : undefined;
}

function processSink(stream: NodeProcessStream): ByteSink {
  return (chunk) =>
    new Promise<void>((resolve, reject) => {
      const flushed = stream.write(chunk, (err) => {
        if (err !== null && err !== undefined) reject(err);
      });
      if (flushed) resolve();
      else stream.once("drain", resolve);
    });
}

// --- p2 stdin: a fed input stream ----------------------------------------------

/**
 * The p2 `input-stream` surface over an asynchronously-fed buffer.
 * Duck-typed against io.ts's registered `InputStream` (the runtime's
 * resource dispatch is per-call and by identity, and the A14 suspending
 * marks relay from the registered prototype — A2).
 */
export class StdinStream {
  #buffer: Uint8Array[] = [];
  #buffered = 0;
  #eof = false;
  #failure: unknown;
  #closed = false;
  /** Wakes blocking readers and pollables (promise-swap producer shape). */
  #wake = (): void => {};
  #wakePromise: Promise<void>;
  /** Resumes a paused feed once the buffer drains. */
  #resume = (): void => {};

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#wakePromise = new Promise((r) => (this.#wake = r));
    void this.#feed(source);
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wakePromise = new Promise((r) => (this.#wake = r));
    wake();
  }

  async #feed(source: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of source) {
        if (this.#closed) return; // reader gone; stop pulling
        if (chunk.length === 0) continue;
        this.#buffer.push(chunk);
        this.#buffered += chunk.length;
        this.#signal();
        while (this.#buffered >= STDIO_HIGH_WATER && !this.#closed) {
          await new Promise<void>((r) => (this.#resume = r));
        }
      }
      this.#eof = true;
    } catch (e) {
      this.#failure = e;
      this.#eof = true;
    }
    this.#signal();
  }

  #take(len: number): Uint8Array {
    const out = new Uint8Array(Math.min(len, this.#buffered));
    let at = 0;
    while (at < out.length) {
      const head = this.#buffer[0];
      const take = Math.min(head.length, out.length - at);
      out.set(head.subarray(0, take), at);
      at += take;
      if (take === head.length) this.#buffer.shift();
      else this.#buffer[0] = head.subarray(take);
    }
    this.#buffered -= out.length;
    if (this.#buffered < STDIO_HIGH_WATER) this.#resume();
    return out;
  }

  read(len: bigint): Uint8Array {
    if (this.#closed) throw closedError();
    if (this.#failure !== undefined) throw closedError();
    if (this.#buffered > 0) return this.#take(Number(len));
    if (this.#eof) throw closedError(); // drained + ended = closed
    return new Uint8Array(0); // open, nothing available: p2 non-blocking read
  }

  /** Parks (A14/A2 mark relay from io.ts's registered prototype). */
  @suspending
  blockingRead(len: bigint): Uint8Array | Promise<Uint8Array> {
    if (this.#buffered > 0 || this.#eof || this.#closed) return this.read(len);
    return (async () => {
      while (this.#buffered === 0 && !this.#eof && !this.#closed) {
        await this.#wakePromise;
      }
      return this.read(len);
    })();
  }

  skip(len: bigint): bigint {
    return BigInt(this.read(len).length);
  }

  @suspending
  blockingSkip(len: bigint): bigint | Promise<bigint> {
    const r = this.blockingRead(len);
    if (r instanceof Uint8Array) return BigInt(r.length);
    return r.then((bytes) => BigInt(bytes.length));
  }

  subscribe(): Pollable {
    return new Pollable(
      () => this.#buffered > 0 || this.#eof || this.#closed,
      () => this.#wakePromise,
    );
  }

  [Symbol.dispose](): void {
    this.#closed = true;
    this.#resume(); // let a parked feed observe the close
    this.#signal();
  }
}

// --- p2 stdout/stderr: a budgeted async-sink output stream ----------------------

/**
 * The p2 `output-stream` surface over an async sink, with a real byte
 * budget: `check-write` reports the remaining permit, blocking ops park
 * until the sink drained (A14/A2 mark relay).
 */
export class StdoutStream {
  #sink: ByteSink;
  #queued = 0;
  #closed = false;
  #failure: unknown;
  /** The pump: a serialized chain of sink calls. */
  #tail: Promise<void> = Promise.resolve();
  #wake = (): void => {};
  #wakePromise: Promise<void>;

  constructor(sink: ByteSink) {
    this.#sink = sink;
    this.#wakePromise = new Promise((r) => (this.#wake = r));
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wakePromise = new Promise((r) => (this.#wake = r));
    wake();
  }

  #checkOpen(): void {
    if (this.#closed) throw closedError();
    if (this.#failure !== undefined) {
      // stream-error.last-operation-failed carries the io `error` RESOURCE.
      throw new ComponentException({
        kind: "last-operation-failed",
        value: new IoError(
          this.#failure instanceof Error ? this.#failure.message : String(this.#failure),
        ),
      });
    }
  }

  checkWrite(): bigint {
    this.#checkOpen();
    return BigInt(Math.max(0, STDIO_HIGH_WATER - this.#queued));
  }

  write(contents: Uint8Array): void {
    this.#checkOpen();
    if (contents.length > STDIO_HIGH_WATER - this.#queued) {
      // Writing past the permit is the guest's contract violation: a
      // trap (unbranded throw), not a stream-error.
      throw new Error(
        "wasi:io/streams.write: contents exceed the check-write permit",
      );
    }
    this.#queued += contents.length;
    this.#tail = this.#tail.then(async () => {
      try {
        if (this.#failure === undefined) await this.#sink(contents);
      } catch (e) {
        this.#failure = e;
      } finally {
        this.#queued -= contents.length;
        this.#signal();
      }
    });
  }

  flush(): void {
    this.#checkOpen();
  }

  /** Parks until the sink drained everything (A14/A2 mark relay). */
  @suspending
  blockingFlush(): void | Promise<void> {
    this.#checkOpen();
    if (this.#queued === 0) return;
    return (async () => {
      while (this.#queued > 0 && this.#failure === undefined) {
        await this.#wakePromise;
      }
      this.#checkOpen();
    })();
  }

  /** Parks until this write (and everything before it) drained. */
  @suspending
  blockingWriteAndFlush(contents: Uint8Array): void | Promise<void> {
    this.write(contents);
    return this.blockingFlush();
  }

  subscribe(): Pollable {
    return new Pollable(
      () => this.#closed || this.#failure !== undefined || this.#queued < STDIO_HIGH_WATER,
      () => this.#wakePromise,
    );
  }

  writeZeroes(len: bigint): void {
    this.write(new Uint8Array(Number(len)));
  }

  @suspending
  blockingWriteZeroesAndFlush(len: bigint): void | Promise<void> {
    return this.blockingWriteAndFlush(new Uint8Array(Number(len)));
  }

  splice(src: { read(len: bigint): Uint8Array }, len: bigint): bigint {
    const chunk = src.read(len);
    this.write(chunk);
    return BigInt(chunk.length);
  }

  @suspending
  blockingSplice(
    src: { read(len: bigint): Uint8Array },
    len: bigint,
  ): bigint | Promise<bigint> {
    const n = this.splice(src, len);
    const flushed = this.blockingFlush();
    if (flushed === undefined) return n;
    return flushed.then(() => n);
  }

  [Symbol.dispose](): void {
    this.#closed = true;
    this.#signal();
  }
}

/**
 * `wasi:cli` over the host process's stdio (both tracks — module header).
 */
export function cliStdio(options: CliStdioOptions = {}): CliStdio {
  const proc = hostProcess();
  const stdinSource = options.stdin ?? proc?.stdin;
  const stdoutSink = options.stdout ??
    (proc?.stdout === undefined ? undefined : processSink(proc.stdout));
  const stderrSink = options.stderr ??
    (proc?.stderr === undefined ? undefined : processSink(proc.stderr));
  if (stdinSource === undefined || stdoutSink === undefined || stderrSink === undefined) {
    throw new TypeError(
      "cliStdio: no host process stdio and no injected replacement — " +
        "on hosts without `process` (browsers), inject sources/sinks or " +
        "use the capture impl (cli.ts)",
    );
  }
  const tty = {
    stdin: options.isTty?.stdin ?? (proc?.stdin as { isTTY?: boolean } | undefined)?.isTTY ?? false,
    stdout: options.isTty?.stdout ?? proc?.stdout?.isTTY ?? false,
    stderr: options.isTty?.stderr ?? proc?.stderr?.isTTY ?? false,
  };
  const env = (): [string, string][] => {
    if (options.env !== undefined) return Object.entries(options.env);
    const e = proc?.env ?? {};
    return Object.entries(e).filter((kv): kv is [string, string] => kv[1] !== undefined);
  };
  const args = (): string[] => options.args ?? proc?.argv?.slice(2) ?? [];
  const cwd = (): string | undefined => options.cwd ?? proc?.cwd?.();

  const doExit = (ok: boolean, code?: number): never => {
    if (options.exitProcess && proc?.exit !== undefined) {
      proc.exit(code ?? (ok ? 0 : 1));
    }
    throw new ExitError(ok, code);
  };

  // One p2 stream per stdio channel, shared across get-* calls (the
  // process's stdio is one resource, not one per call).
  let p2Stdin: StdinStream | undefined;
  const p2Stdout = new StdoutStream(stdoutSink);
  const p2Stderr = new StdoutStream(stderrSink);

  // 0.3 write-via-stream: drain the guest's stream to the sink; the
  // promise is the future source (A12).
  const writeViaStream = (sink: ByteSink) => async (data: CliByteSource): Promise<CliIoResult> => {
    try {
      for await (const chunk of data as AsyncIterable<Uint8Array | number[]>) {
        await sink(chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk));
      }
      return OK;
    } catch (e) {
      if (data instanceof Stream) data.drop(); // the guest's writer must not hang
      return { kind: "err", value: ioErrorCode(e) };
    }
  };

  // 0.3 read-via-stream: the tcp-receive tuple over the shared source.
  const readViaStream = (): [AsyncIterable<Uint8Array>, Promise<CliIoResult>] => {
    let settle!: (r: CliIoResult) => void;
    const done = new Promise<CliIoResult>((r) => (settle = r));
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of stdinSource) {
          if (chunk.length > 0) yield chunk;
        }
        settle(OK);
      } catch (e) {
        settle({ kind: "err", value: ioErrorCode(e) });
      } finally {
        settle(OK); // reader dropped: the canceller observes (no-op if settled)
      }
    })();
    return [source, done];
  };

  const environment = {
    getEnvironment: env,
    getArguments: args,
  };

  const imports: Record<string, unknown> = {
    // ---- @0.2 -----------------------------------------------------------------
    "wasi:cli/environment@0.2": { ...environment, initialCwd: cwd },
    "wasi:cli/exit@0.2": {
      exit: (status: { kind: "ok" | "err" }): void => {
        doExit(status.kind === "ok");
      },
    },
    "wasi:cli/stdin@0.2": {
      getStdin: (): StdinStream => (p2Stdin ??= new StdinStream(stdinSource)),
    },
    "wasi:cli/stdout@0.2": { getStdout: (): StdoutStream => p2Stdout },
    "wasi:cli/stderr@0.2": { getStderr: (): StdoutStream => p2Stderr },
    "wasi:cli/terminal-input@0.2": { TerminalInput },
    "wasi:cli/terminal-output@0.2": { TerminalOutput },
    "wasi:cli/terminal-stdin@0.2": {
      getTerminalStdin: (): TerminalInput | undefined =>
        tty.stdin ? new TerminalInput() : undefined,
    },
    "wasi:cli/terminal-stdout@0.2": {
      getTerminalStdout: (): TerminalOutput | undefined =>
        tty.stdout ? new TerminalOutput() : undefined,
    },
    "wasi:cli/terminal-stderr@0.2": {
      getTerminalStderr: (): TerminalOutput | undefined =>
        tty.stderr ? new TerminalOutput() : undefined,
    },

    // ---- @0.3 -----------------------------------------------------------------
    "wasi:cli/types@0.3": {},
    "wasi:cli/environment@0.3": { ...environment, getInitialCwd: cwd },
    "wasi:cli/exit@0.3": {
      exit: (status: { kind: "ok" | "err" }): void => {
        doExit(status.kind === "ok");
      },
      exitWithCode: (statusCode: number): void => {
        doExit(statusCode === 0, statusCode);
      },
    },
    "wasi:cli/stdin@0.3": { readViaStream },
    "wasi:cli/stdout@0.3": { writeViaStream: writeViaStream(stdoutSink) },
    "wasi:cli/stderr@0.3": { writeViaStream: writeViaStream(stderrSink) },
    "wasi:cli/terminal-input@0.3": { TerminalInput },
    "wasi:cli/terminal-output@0.3": { TerminalOutput },
    "wasi:cli/terminal-stdin@0.3": {
      getTerminalStdin: (): TerminalInput | undefined =>
        tty.stdin ? new TerminalInput() : undefined,
    },
    "wasi:cli/terminal-stdout@0.3": {
      getTerminalStdout: (): TerminalOutput | undefined =>
        tty.stdout ? new TerminalOutput() : undefined,
    },
    "wasi:cli/terminal-stderr@0.3": {
      getTerminalStderr: (): TerminalOutput | undefined =>
        tty.stderr ? new TerminalOutput() : undefined,
    },
  };

  return { imports };
}
