//! translator-shim: `wasmtime-environ`'s component frontend (validation,
//! linking resolution, FACT fused-adapter synthesis) behind a stable output
//! format — the **plan v0** of `contracts/plan-format.md`.
//!
//! Promoted from the S0 spike (`crates/translator-spike`). The spike's debug
//! `Summary` is replaced by the contract artifact set:
//!
//! - `plan.json` — the plan (schema: `src/plan.rs`)
//! - `adapters/<static-module-index>.wasm` — FACT-generated core modules
//!
//! Over the wasm C-ABI both are returned in one JSON **envelope**
//! (shim-internal wire format, see README.md):
//!
//! ```json
//! { "plan": { ... }, "adapters": [ { "file": "adapters/2.wasm", "wasm": "<base64>" } ] }
//! ```
//!
//! Exact wasmtime-environ 47.0.3 entry points used:
//!
//! - `Translator::new(&Tunables, &mut wasmparser::Validator,
//!   &mut ComponentTypesBuilder, &ScopeVec<u8>)`
//! - `Translator::translate(self, &[u8]) -> Result<(ComponentTranslation,
//!   PrimaryMap<StaticModuleIndex, ModuleTranslation>)>`
//! - `ComponentTypesBuilder::finish(&Component) -> (ComponentTypes, _)` for
//!   the post-translation type tables (component types + interned core types).
//!
//! FACT-generated adapter modules come back as *extra entries* in the returned
//! `PrimaryMap<StaticModuleIndex, ModuleTranslation>`, after the component's
//! embedded core modules. They are distinguished by checking whether a
//! module's `wasm` slice points into the input component buffer (embedded) or
//! into the `ScopeVec` arena (FACT-generated).

use std::collections::HashMap;

use anyhow::{bail, Result};
use base64::Engine as _;
use serde::Serialize;
use wasmtime_environ::component::{ComponentTypesBuilder, Translator};
use wasmtime_environ::{ScopeVec, Tunables};

pub mod plan;

pub use plan::Plan;

/// One FACT adapter artifact: file name (as referenced from
/// `plan.modules[].file`) plus raw core-wasm bytes.
#[derive(Debug)]
pub struct AdapterArtifact {
    pub file: String,
    pub wasm: Vec<u8>,
}

/// Full translation output: the contract's artifact set.
#[derive(Debug)]
pub struct Translation {
    pub plan: Plan,
    pub adapters: Vec<AdapterArtifact>,
}

/// Wasm feature set used for validation during translation.
///
/// `wasmparser` 0.252 defaults already include `component_model` and
/// `cm_async` (component-model-async). We additionally enable the async
/// trailing features; this mirrors wasmtime's
/// `-W component-model-async=y,component-model-error-context=y`.
fn features() -> wasmparser::WasmFeatures {
    let mut f = wasmparser::WasmFeatures::default();
    f.insert(wasmparser::WasmFeatures::CM_ASYNC);
    f.insert(wasmparser::WasmFeatures::CM_ASYNC_STACKFUL);
    f.insert(wasmparser::WasmFeatures::CM_MORE_ASYNC_BUILTINS);
    f.insert(wasmparser::WasmFeatures::CM_ERROR_CONTEXT);
    f
}

/// Feature names recorded in `plan.producer.features`. Must describe
/// `features()` — part of the artifact-cache key.
fn feature_names() -> Vec<String> {
    ["cm-async", "cm-async-stackful", "cm-more-async-builtins", "cm-error-context"]
        .map(String::from)
        .to_vec()
}

/// Translate a component binary into plan v0 + adapter artifacts.
///
/// Runs wasmtime's full component frontend: parse + validate + type-check the
/// component, resolve its linking structure to a flat initializer list, run
/// FACT to synthesize fused adapters, then map everything to the plan schema.
pub fn translate(component_bytes: &[u8]) -> Result<Translation> {
    // `default_u32()` rather than `default_host()`: keeps native tests and the
    // wasm32 build byte-identical. FACT consults only `concurrency_support`
    // (true) and `debug_adapter_modules` (false) from tunables.
    let tunables = Tunables::default_u32();
    let mut validator = wasmparser::Validator::new_with_features(features());
    let mut types = ComponentTypesBuilder::new(&validator);
    let scope = ScopeVec::new();

    let (translation, modules) =
        Translator::new(&tunables, &mut validator, &mut types, &scope).translate(component_bytes)?;

    // Capture counts only available on the builder, then finish the type
    // tables (moves core module types in as well).
    let num_resource_tables = types.num_resource_tables();
    let (component_types, _world_ty) = types.finish(&translation.component);

    // Distinguish embedded modules (slices of the input) from FACT adapters
    // (owned by the ScopeVec arena) by pointer containment.
    let base = component_bytes.as_ptr() as usize;
    let end = base + component_bytes.len();

    let mut module_entries = Vec::new();
    let mut adapters = Vec::new();
    let mut adapter_import_names: HashMap<u32, Vec<(String, String)>> = HashMap::new();
    let mut module_export_names = Vec::new();

    for (idx, mt) in modules.iter() {
        let ptr = mt.wasm.as_ptr() as usize;
        let embedded = ptr >= base && ptr + mt.wasm.len() <= end;

        // Export-name table (EntityIndex -> name), for ExportItem::Index
        // resolution in the plan builder.
        let export_names: Vec<(String, wasmtime_environ::EntityIndex)> = mt
            .module
            .exports
            .iter()
            .map(|(atom, entity)| (mt.module.strings[*atom].to_string(), *entity))
            .collect();
        module_export_names.push(export_names);

        if embedded {
            let offset = mt.wasm_module_offset;
            // Sanity: the recorded offset must locate exactly this slice.
            if offset as usize != ptr - base {
                bail!(
                    "module {}: wasm_module_offset {} disagrees with slice position {}",
                    idx.as_u32(),
                    offset,
                    ptr - base
                );
            }
            module_entries.push(plan::ModuleEntry::Embedded {
                offset,
                len: mt.wasm.len(),
            });
        } else {
            let file = format!("adapters/{}.wasm", idx.as_u32());
            module_entries.push(plan::ModuleEntry::Adapter {
                file: file.clone(),
                len: mt.wasm.len(),
                intrinsics: Vec::new(), // filled by PlanBuilder::build
            });
            adapter_import_names.insert(
                idx.as_u32(),
                mt.module
                    .imports()
                    .map(|(module, field, _)| (module.to_string(), field.to_string()))
                    .collect(),
            );
            adapters.push(AdapterArtifact {
                file,
                wasm: mt.wasm.to_vec(),
            });
        }
    }

    let producer = plan::Producer {
        shim_version: env!("CARGO_PKG_VERSION").to_string(),
        wasmtime_environ: "47.0.3".to_string(),
        features: feature_names(),
    };
    let component_id = plan::ComponentId {
        sha256: plan::sha256_hex(component_bytes),
        len: component_bytes.len(),
    };

    let plan = plan::PlanBuilder::new(
        &translation.component,
        &translation.trampolines,
        &component_types,
        module_export_names,
        num_resource_tables,
    )
    .build(producer, component_id, module_entries, &adapter_import_names)?;

    Ok(Translation { plan, adapters })
}

// ---------------------------------------------------------------------------
// Envelope (C-ABI wire format)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct EnvelopeAdapter<'a> {
    file: &'a str,
    wasm: String, // base64 (standard alphabet, padded)
}

#[derive(Serialize)]
struct Envelope<'a> {
    plan: &'a Plan,
    adapters: Vec<EnvelopeAdapter<'a>>,
}

/// Serialize a translation to the single-JSON envelope returned over the
/// C-ABI. Deterministic: struct field order is fixed, maps are not used,
/// and adapter bytes are deterministic FACT output.
pub fn to_envelope_json(t: &Translation) -> Result<String> {
    let envelope = Envelope {
        plan: &t.plan,
        adapters: t
            .adapters
            .iter()
            .map(|a| EnvelopeAdapter {
                file: &a.file,
                wasm: base64::engine::general_purpose::STANDARD.encode(&a.wasm),
            })
            .collect(),
    };
    Ok(serde_json::to_string(&envelope)?)
}

/// Convenience: translate and produce the envelope (or an error envelope).
/// This is the function behind `ts_translate`; it never panics on invalid
/// input, returning `{"error": "..."}` instead.
pub fn translate_to_envelope(component_bytes: &[u8]) -> String {
    match translate(component_bytes).and_then(|t| to_envelope_json(&t)) {
        Ok(json) => json,
        Err(e) => serde_json::to_string(&serde_json::json!({ "error": format!("{e:?}") }))
            .unwrap_or_else(|_| r#"{"error":"unknown"}"#.to_string()),
    }
}

/// C-ABI surface for the wasm32 build (used by the Deno driver).
///
/// Contract (unchanged from the spike):
/// - `ts_alloc(len) -> ptr`: allocate `len` bytes (caller writes input here).
/// - `ts_translate(ptr, len, out_len: *mut usize) -> out_ptr`: translate the
///   component at `ptr..ptr+len`. Writes the output length to `*out_len` and
///   returns the output pointer; the output is UTF-8 JSON — either the
///   envelope (`{"plan":…, "adapters":…}`) or `{"error": "..."}`.
/// - `ts_dealloc(ptr, len)`: free a buffer from `ts_alloc`/`ts_translate`.
pub mod cabi {
    use super::translate_to_envelope;

    #[no_mangle]
    pub extern "C" fn ts_alloc(len: usize) -> *mut u8 {
        let mut buf = Vec::<u8>::with_capacity(len);
        let ptr = buf.as_mut_ptr();
        core::mem::forget(buf);
        ptr
    }

    /// # Safety
    /// `ptr` must come from `ts_alloc`/`ts_translate` with the same `len`.
    #[no_mangle]
    pub unsafe extern "C" fn ts_dealloc(ptr: *mut u8, len: usize) {
        if !ptr.is_null() && len != 0 {
            drop(Vec::from_raw_parts(ptr, 0, len));
        }
    }

    /// # Safety
    /// `ptr..ptr+len` must be valid initialized memory (from `ts_alloc`);
    /// `out_len` must be valid for a `usize` write.
    #[no_mangle]
    pub unsafe extern "C" fn ts_translate(
        ptr: *const u8,
        len: usize,
        out_len: *mut usize,
    ) -> *mut u8 {
        let bytes = core::slice::from_raw_parts(ptr, len);
        let json = translate_to_envelope(bytes);
        // Copy into a fresh exact-size allocation (same layout contract as
        // `ts_alloc`) rather than leaking the String's own buffer: capacity
        // == len is then guaranteed for `ts_dealloc`.
        let src = json.as_bytes();
        let out = ts_alloc(src.len());
        core::ptr::copy_nonoverlapping(src.as_ptr(), out, src.len());
        *out_len = src.len();
        out
    }
}
