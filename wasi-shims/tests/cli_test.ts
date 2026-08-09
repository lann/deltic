// wasi:cli@0.2 — stdout/stderr capture, exit recording (contracts/
// embedder-api.md §"WASI examination"; C2 gate: "stdout capture, exit
// recording").

import { assertEq, assertThrows, assertTrue } from "./asserts.ts";
import { cli, ExitError } from "../src/cli.ts";

Deno.test("cli: stdout capture accumulates writes and decodes as text", () => {
  const { imports, captured } = cli();
  const stdoutIface = imports["wasi:cli/stdout@0.2"] as {
    getStdout(): { write(c: Uint8Array): void };
  };
  const stdout = stdoutIface.getStdout();
  stdout.write(new TextEncoder().encode("hello "));
  stdout.write(new TextEncoder().encode("world"));
  assertEq(captured.stdoutText(), "hello world");
  assertEq(captured.stderrText(), "");
});

Deno.test("cli: stderr capture is independent of stdout", () => {
  const { imports, captured } = cli();
  const stderrIface = imports["wasi:cli/stderr@0.2"] as {
    getStderr(): { write(c: Uint8Array): void };
  };
  stderrIface.getStderr().write(new TextEncoder().encode("oops"));
  assertEq(captured.stderrText(), "oops");
  assertEq(captured.stdoutText(), "");
});

Deno.test("cli: exit() records status without throwing by default", () => {
  const { imports, captured } = cli();
  const exitIface = imports["wasi:cli/exit@0.2"] as {
    exit(status: { tag: "ok" | "err" }): void;
  };
  assertEq(captured.exited(), false);
  exitIface.exit({ tag: "ok" });
  assertEq(captured.exited(), true);
  assertEq(captured.exitOk(), true);
});

Deno.test("cli: exit() with throwOnExit throws a named ExitError", () => {
  const { imports } = cli({ throwOnExit: true });
  const exitIface = imports["wasi:cli/exit@0.2"] as {
    exit(status: { tag: "ok" | "err" }): void;
  };
  const e = assertThrows(() => exitIface.exit({ tag: "err" }));
  assertTrue(e instanceof ExitError, "throw is an ExitError");
  assertEq((e as ExitError).ok, false);
});

Deno.test("cli: get-environment / get-arguments / initial-cwd from options", () => {
  const { imports } = cli({
    env: { FOO: "bar" },
    args: ["a", "b"],
    cwd: "/work",
  });
  const env = imports["wasi:cli/environment@0.2"] as {
    getEnvironment(): [string, string][];
    getArguments(): string[];
    initialCwd(): string | undefined;
  };
  assertEq(JSON.stringify(env.getEnvironment()), JSON.stringify([["FOO", "bar"]]));
  assertEq(JSON.stringify(env.getArguments()), JSON.stringify(["a", "b"]));
  assertEq(env.initialCwd(), "/work");
});

Deno.test("cli: get-environment / get-arguments default to empty", () => {
  const { imports } = cli();
  const env = imports["wasi:cli/environment@0.2"] as {
    getEnvironment(): [string, string][];
    getArguments(): string[];
    initialCwd(): string | undefined;
  };
  assertEq(env.getEnvironment().length, 0);
  assertEq(env.getArguments().length, 0);
  assertEq(env.initialCwd(), undefined);
});

Deno.test("cli: stdin is empty by default", () => {
  const { imports } = cli();
  const stdin = imports["wasi:cli/stdin@0.2"] as {
    getStdin(): { read(len: bigint): Uint8Array };
  };
  const s = stdin.getStdin();
  assertEq(s.read(10n).length, 0);
});

Deno.test("cli: no terminal is ever attached (option collapses to undefined)", () => {
  const { imports } = cli();
  const stdinTerm = imports["wasi:cli/terminal-stdin@0.2"] as {
    getTerminalStdin(): unknown;
  };
  assertEq(stdinTerm.getTerminalStdin(), undefined);
});
