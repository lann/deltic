// JSON command runner: executes one testgen-generated command file against a
// CommandExecutor, classifying every command as passed / failed / skipped.

import type {
  Action,
  ArtifactRef,
  Command,
  Value,
  WastJson,
} from "./schema.ts";
import {
  type Artifact,
  type CommandExecutor,
  type InstanceRef,
  type InvokeOutcome,
  LinkError,
  PendingRuntimeError,
  TrapError,
} from "./executor.ts";

export type SkipReason = "pending-runtime" | "unsupported-directive";

export interface CommandResult {
  line: number;
  type: string;
  status: "passed" | "failed" | "skipped";
  /** Set when status === "skipped". */
  reason?: SkipReason;
  detail?: string;
}

export interface FileResult {
  source: string;
  results: CommandResult[];
}

/** Reads an artifact file referenced by a command file. */
export type ArtifactLoader = (
  filename: string,
) => Promise<Uint8Array<ArrayBuffer>>;

export async function runWastJson(
  doc: WastJson,
  loadArtifact: ArtifactLoader,
  executor: CommandExecutor,
): Promise<FileResult> {
  const runner = new FileRunner(loadArtifact, executor);
  const results: CommandResult[] = [];
  try {
    for (const command of doc.commands) {
      results.push(await runner.run(command));
    }
  } finally {
    executor.reset();
  }
  return { source: doc.source_filename, results };
}

class FileRunner {
  /** Named instances created so far in this file. */
  instances = new Map<string, InstanceRef>();
  /** Default target for actions: the most recent instantiation. */
  current: InstanceRef | undefined;

  constructor(
    readonly loadArtifact: ArtifactLoader,
    readonly executor: CommandExecutor,
  ) {}

  async run(command: Command): Promise<CommandResult> {
    const base = { line: command.line, type: command.type };
    try {
      const detail = await this.dispatch(command);
      return { ...base, status: "passed", ...(detail ? { detail } : {}) };
    } catch (e) {
      if (e instanceof PendingRuntimeError) {
        return {
          ...base,
          status: "skipped",
          reason: "pending-runtime",
          detail: e.message,
        };
      }
      if (e instanceof UnsupportedDirective) {
        return {
          ...base,
          status: "skipped",
          reason: "unsupported-directive",
          detail: e.message,
        };
      }
      return { ...base, status: "failed", detail: String(e) };
    }
  }

  /** Returns an optional pass detail; throws on failure/skip. */
  async dispatch(command: Command): Promise<string | undefined> {
    switch (command.type) {
      case "module": {
        const artifact = await this.artifact(command);
        const ref = await this.executor.instantiate(artifact, "success");
        this.current = ref;
        if (command.name !== undefined) this.instances.set(command.name, ref);
        return undefined;
      }
      case "module_definition": {
        const artifact = await this.artifact(command);
        await this.executor.define(command.name, artifact);
        return undefined;
      }
      case "module_instance": {
        const ref = await this.executor.instantiateDefinition(
          command.module,
          command.instance,
        );
        this.current = ref;
        if (command.instance !== undefined) {
          this.instances.set(command.instance, ref);
        }
        return undefined;
      }
      case "register": {
        const target = command.name === undefined
          ? this.current
          : this.instances.get(command.name);
        await this.executor.register(command.as, target);
        return undefined;
      }
      case "action": {
        const outcome = await this.action(command.action);
        if (outcome.kind === "trapped") {
          throw new Error(`action trapped: ${outcome.message}`);
        }
        return undefined;
      }
      case "assert_return": {
        const outcome = await this.action(command.action);
        if (outcome.kind === "trapped") {
          throw new Error(`expected return, got trap: ${outcome.message}`);
        }
        const mismatch = compareValues(command.expected, outcome.values);
        if (mismatch !== undefined) throw new Error(mismatch);
        return undefined;
      }
      case "assert_trap": {
        const outcome = await this.action(command.action);
        if (outcome.kind !== "trapped") {
          throw new Error(`expected trap "${command.text}", got return`);
        }
        if (!trapMatches(command.text, outcome.message)) {
          throw new Error(
            `expected trap "${command.text}", got "${outcome.message}"`,
          );
        }
        return undefined;
      }
      case "assert_exhaustion":
      case "assert_exception":
      case "assert_suspension":
        // Not used by the component-model suite; revisit when a suite needs
        // them rather than guessing semantics now.
        throw new UnsupportedDirective(command.type);
      case "assert_invalid":
      case "assert_malformed": {
        // The JS API cannot distinguish malformed from invalid, and neither
        // can a black-box runtime verdict; both accept "not valid".
        const artifact = await this.artifact(command);
        const { valid } = await this.executor.validate(artifact);
        if (valid) {
          throw new Error(
            `expected ${command.type} ("${command.text}"), but it validated`,
          );
        }
        return undefined;
      }
      case "assert_uninstantiable": {
        const artifact = await this.artifact(command);
        try {
          await this.executor.instantiate(artifact, "trap");
        } catch (e) {
          if (e instanceof TrapError) return undefined;
          throw e;
        }
        throw new Error(
          `expected instantiation trap "${command.text}", but it instantiated`,
        );
      }
      case "assert_unlinkable": {
        const artifact = await this.artifact(command);
        try {
          await this.executor.instantiate(artifact, "link-error");
        } catch (e) {
          if (e instanceof LinkError) return undefined;
          throw e;
        }
        throw new Error(
          `expected link error "${command.text}", but it instantiated`,
        );
      }
      default:
        // Future/unknown command types (e.g. assert_invalid_custom).
        throw new UnsupportedDirective(
          `unknown command type: ${(command as { type: string }).type}`,
        );
    }
  }

  async artifact(ref: ArtifactRef): Promise<Artifact> {
    if (ref.module_type === "text") {
      // Only `(... quote ...)` forms whose malformedness lives at the text
      // level; executable only by a host with a text parser.
      throw new UnsupportedDirective(`text artifact ${ref.filename}`);
    }
    return {
      filename: ref.filename,
      kind: ref.kind,
      moduleType: ref.module_type,
      bytes: await this.loadArtifact(ref.filename),
    };
  }

  action(action: Action): Promise<InvokeOutcome> {
    const target = action.module === undefined
      ? this.current
      : this.instances.get(action.module);
    if (action.type === "invoke") {
      return this.executor.invoke(target, action.field, action.args);
    }
    return this.executor.get(target, action.field);
  }
}

class UnsupportedDirective extends Error {}

/** Trap-message matching: official interpreters compare by prefix/substring;
 * wasmtime does the same. Provisional until the runtime pins semantics. */
function trapMatches(expected: string, actual: string): boolean {
  return actual.includes(expected);
}

/**
 * Structural comparison of expected vs actual values.
 * PROVISIONAL: strict deep equality on the JSON encoding; NaN patterns
 * (`nan:canonical`/`nan:arithmetic`) and core `either` alternatives are not
 * yet interpreted — no invoke executes today, so nothing reaches this. The
 * runtime work must replace this with CABI-aware comparison.
 * Returns an error message, or undefined if equal.
 */
export function compareValues(
  expected: Value[],
  actual: Value[],
): string | undefined {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e !== a) return `expected ${e}, got ${a}`;
  return undefined;
}
