//! JSON schema for converted `.wast` files.
//!
//! The shape deliberately mirrors `wasm-tools json-from-wast` (which itself
//! mirrors WABT's `wast2json`, see
//! <https://github.com/WebAssembly/wabt/blob/main/docs/wast2json.md>), with
//! two extensions:
//!
//! - every command that references an on-disk artifact carries a `kind`
//!   field: `"module"` (core wasm) or `"component"`, so consumers never have
//!   to sniff binary layer preambles;
//! - component-level values (`WastVal`) have a documented encoding covering
//!   compound types (list/record/tuple/variant/enum/option/result/flags).
//!
//! See harness/README.md for the full schema documentation.

use serde::Serialize;

#[derive(Serialize)]
pub struct WastJson {
    pub source_filename: String,
    pub commands: Vec<Command>,
}

/// Which layer an extracted artifact belongs to.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A core wasm module (binary version 0x1, layer absent).
    Module,
    /// A component (binary layer 0x1).
    Component,
}

/// Whether the artifact file is a binary (`.wasm`) or raw text (`.wat`).
///
/// Text artifacts only occur for `(... quote "...")` forms whose text cannot
/// be (or, for `assert_malformed`, must not be) converted to a binary.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModuleType {
    Binary,
    Text,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Define, validate, and instantiate a top-level module/component. Its
    /// exports become the default target for subsequent actions.
    Module {
        line: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        filename: String,
        module_type: ModuleType,
        kind: Kind,
    },
    /// `(component definition ...)` / `(module definition ...)`: define and
    /// validate only; instantiated later by `module_instance`.
    ModuleDefinition {
        line: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        filename: String,
        module_type: ModuleType,
        kind: Kind,
    },
    /// `(component instance $i $M)`: instantiate a prior `module_definition`
    /// (`module == None` means the most recent definition). The new instance
    /// becomes the default action target.
    ModuleInstance {
        line: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        instance: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        module: Option<String>,
    },
    /// Make an instance's exports importable by later modules under `as`.
    Register {
        line: usize,
        #[serde(rename = "as")]
        as_: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    /// Perform an action, ignore results (must not trap).
    Action { line: usize, action: Action },
    AssertReturn {
        line: usize,
        action: Action,
        expected: Vec<Value>,
    },
    AssertTrap {
        line: usize,
        action: Action,
        text: String,
    },
    AssertExhaustion {
        line: usize,
        action: Action,
        text: String,
    },
    AssertException { line: usize, action: Action },
    AssertSuspension {
        line: usize,
        action: Action,
        text: String,
    },
    /// Module/component must fail *validation* with an error matching `text`.
    AssertInvalid {
        line: usize,
        filename: String,
        module_type: ModuleType,
        kind: Kind,
        text: String,
    },
    /// Module/component must fail *decoding* (binary) or *parsing* (text).
    AssertMalformed {
        line: usize,
        filename: String,
        module_type: ModuleType,
        kind: Kind,
        text: String,
    },
    /// Module/component validates but must trap during instantiation.
    /// (Produced from `(assert_trap (component ...) "...")`.)
    AssertUninstantiable {
        line: usize,
        filename: String,
        module_type: ModuleType,
        kind: Kind,
        text: String,
    },
    /// Module/component validates but must fail to link.
    AssertUnlinkable {
        line: usize,
        filename: String,
        module_type: ModuleType,
        kind: Kind,
        text: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Invoke {
        /// Named instance to invoke on; `None` = current default instance.
        #[serde(skip_serializing_if = "Option::is_none")]
        module: Option<String>,
        field: String,
        args: Vec<Value>,
    },
    Get {
        #[serde(skip_serializing_if = "Option::is_none")]
        module: Option<String>,
        field: String,
    },
}

/// A core or component value. `type` discriminates; the payload fields are
/// documented in harness/README.md. Scalars are decimal strings (floats are
/// *bit patterns*); compound component values nest `Value`s.
#[derive(Serialize)]
pub struct Value {
    #[serde(rename = "type")]
    pub ty: String,
    /// v128 only: the lane interpretation used in the source text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane_type: Option<String>,
    /// variant only: case name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case: Option<String>,
    /// result only: "ok" | "err".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub value: serde_json::Value,
}

impl Value {
    pub fn simple(ty: impl Into<String>, value: impl Into<serde_json::Value>) -> Value {
        Value {
            ty: ty.into(),
            lane_type: None,
            case: None,
            status: None,
            value: value.into(),
        }
    }
}
