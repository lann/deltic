// JSON schema for testgen-generated command files (see harness/README.md).
// Mirrors `wasm-tools json-from-wast` / wast2json, with a `kind` extension
// distinguishing core modules from components.

/** Layer of an extracted artifact. */
export type Kind = "module" | "component";

/** Artifact file flavor: `.wasm` binary or raw `.wat` text. */
export type ModuleType = "binary" | "text";

export interface WastJson {
  source_filename: string;
  commands: Command[];
}

export interface ArtifactRef {
  filename: string;
  module_type: ModuleType;
  kind: Kind;
}

export interface ModuleCommand extends ArtifactRef {
  type: "module";
  line: number;
  name?: string;
}

export interface ModuleDefinitionCommand extends ArtifactRef {
  type: "module_definition";
  line: number;
  name?: string;
}

export interface ModuleInstanceCommand {
  type: "module_instance";
  line: number;
  instance?: string;
  /** Definition to instantiate; absent = most recent definition. */
  module?: string;
}

export interface RegisterCommand {
  type: "register";
  line: number;
  as: string;
  name?: string;
}

export interface ActionCommand {
  type: "action";
  line: number;
  action: Action;
}

export interface AssertReturnCommand {
  type: "assert_return";
  line: number;
  action: Action;
  expected: Value[];
}

export interface AssertTrapCommand {
  type: "assert_trap";
  line: number;
  action: Action;
  text: string;
}

export interface AssertExhaustionCommand {
  type: "assert_exhaustion";
  line: number;
  action: Action;
  text: string;
}

export interface AssertExceptionCommand {
  type: "assert_exception";
  line: number;
  action: Action;
}

export interface AssertSuspensionCommand {
  type: "assert_suspension";
  line: number;
  action: Action;
  text: string;
}

export interface AssertInvalidCommand extends ArtifactRef {
  type: "assert_invalid";
  line: number;
  text: string;
}

export interface AssertMalformedCommand extends ArtifactRef {
  type: "assert_malformed";
  line: number;
  text: string;
}

export interface AssertUninstantiableCommand extends ArtifactRef {
  type: "assert_uninstantiable";
  line: number;
  text: string;
}

export interface AssertUnlinkableCommand extends ArtifactRef {
  type: "assert_unlinkable";
  line: number;
  text: string;
}

export type Command =
  | ModuleCommand
  | ModuleDefinitionCommand
  | ModuleInstanceCommand
  | RegisterCommand
  | ActionCommand
  | AssertReturnCommand
  | AssertTrapCommand
  | AssertExhaustionCommand
  | AssertExceptionCommand
  | AssertSuspensionCommand
  | AssertInvalidCommand
  | AssertMalformedCommand
  | AssertUninstantiableCommand
  | AssertUnlinkableCommand;

export interface InvokeAction {
  type: "invoke";
  /** Named instance to invoke on; absent = current default instance. */
  module?: string;
  field: string;
  args: Value[];
}

export interface GetAction {
  type: "get";
  module?: string;
  field: string;
}

export type Action = InvokeAction | GetAction;

/**
 * A core or component value.
 *
 * - scalars (`bool,u8..s64,i32,i64,f32,f64,char,string,enum`): `value` is a
 *   string; floats are decimal *bit patterns* (or `nan:canonical` /
 *   `nan:arithmetic` in expectations);
 * - `list`/`tuple`: `value` is `Value[]`;
 * - `record`: `value` is `{name, value}[]`;
 * - `variant`: `case` is set, `value` is payload `Value` or null;
 * - `option`: `value` is payload `Value` or null (none);
 * - `result`: `status` is "ok"|"err", `value` is payload `Value` or null;
 * - `flags`: `value` is `string[]`;
 * - `v128`: `lane_type` is set, `value` is `string[]` of lanes.
 */
export interface Value {
  type: string;
  lane_type?: string;
  case?: string;
  status?: "ok" | "err";
  value: ValuePayload;
}

export type ValuePayload =
  | string
  | null
  | string[]
  | Value[]
  | RecordField[];

export interface RecordField {
  name: string;
  value: Value;
}
