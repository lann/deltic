//! S0 spike: drive `wasmtime-environ`'s component translator (including the
//! FACT fused-adapter compiler) as a library, natively and on wasm32.
//!
//! Exact API entry points exercised here (wasmtime-environ 47.0.3):
//!
//! - `wasmtime_environ::component::Translator::new(&Tunables, &mut wasmparser::Validator,
//!    &mut ComponentTypesBuilder, &ScopeVec<u8>)`
//! - `Translator::translate(self, &[u8]) -> Result<(ComponentTranslation,
//!    PrimaryMap<StaticModuleIndex, ModuleTranslation>)>`
//! - `wasmtime_environ::component::ComponentTypesBuilder::new(&Validator)`
//! - `wasmtime_environ::Tunables::default_u32()` (FACT only reads
//!   `concurrency_support` + `debug_adapter_modules` from it)
//! - `wasmtime_environ::ScopeVec` (arena that owns FACT-generated module bytes)
//!
//! FACT-generated adapter modules come back as *extra entries* in the returned
//! `PrimaryMap<StaticModuleIndex, ModuleTranslation>`, after the component's
//! embedded core modules. They are distinguished here by checking whether a
//! module's `wasm` slice points into the input component buffer (embedded) or
//! into the `ScopeVec` arena (FACT-generated).

use anyhow::Result;
use serde::Serialize;
use wasmtime_environ::component::{ComponentTypesBuilder, Translator};
use wasmtime_environ::{ScopeVec, Tunables};

/// Summary of one static core module discovered during translation.
///
/// "Static modules" are both the core modules embedded in the component binary
/// and the adapter modules synthesized by FACT.
#[derive(Debug, Serialize)]
pub struct ModuleSummary {
    /// Index in the static-module index space (`StaticModuleIndex`).
    pub index: u32,
    /// `"embedded"` (sliced out of the component binary) or `"fact-adapter"`
    /// (synthesized by FACT during translation).
    pub kind: ModuleKind,
    /// For embedded modules: byte offset of the module within the component
    /// binary (`ModuleTranslation::wasm_module_offset`). `None` for adapters
    /// (they have no location in the input).
    pub offset_in_component: Option<u64>,
    /// Size in bytes of the module's raw wasm.
    pub len: usize,
    /// `module.field: type` for every core import of this module. For FACT
    /// adapters this is exactly the host-intrinsics + linked-definitions
    /// contract (import modules `sync`, `async`, `transfer`, `transcode`,
    /// `callee`, `post_return`, `m<N>`, `f<N>`).
    pub imports: Vec<String>,
    /// Names of core exports.
    pub exports: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum ModuleKind {
    Embedded,
    FactAdapter,
}

/// Result of translating one component.
#[derive(Debug, Serialize)]
pub struct Summary {
    /// Total input size in bytes.
    pub component_len: usize,
    /// Count of core modules that were embedded in the component binary.
    pub num_embedded_modules: usize,
    /// Count of FACT-generated adapter modules.
    pub num_adapter_modules: usize,
    /// Every static module (embedded + adapters), in index order.
    pub modules: Vec<ModuleSummary>,
    /// Flat instantiation/linking plan: `Debug` rendering of each
    /// `GlobalInitializer`, in execution order.
    pub initializers: Vec<String>,
    /// `Debug` rendering of each required host trampoline
    /// (`ComponentTranslation::trampolines`).
    pub trampolines: Vec<String>,
    /// Number of runtime instances the flattened component will create.
    pub num_runtime_instances: u32,
    /// Full pretty `Debug` dump of `wasmtime_environ::component::Component` —
    /// the flattened linking structure (imports, exports, initializers,
    /// canonical options tables, ...).
    pub component_debug: String,
}

/// Wasm feature set used for validation during translation.
///
/// `wasmparser` 0.252 defaults already include `component_model` and
/// `cm_async` (component-model-async). We additionally enable the async
/// trailing features so the async probe can exercise them; this mirrors
/// wasmtime's `-W component-model-async=y,component-model-error-context=y`.
fn features() -> wasmparser::WasmFeatures {
    let mut f = wasmparser::WasmFeatures::default();
    f.insert(wasmparser::WasmFeatures::CM_ASYNC);
    f.insert(wasmparser::WasmFeatures::CM_ASYNC_STACKFUL);
    f.insert(wasmparser::WasmFeatures::CM_MORE_ASYNC_BUILTINS);
    f.insert(wasmparser::WasmFeatures::CM_ERROR_CONTEXT);
    f
}

/// Translate a component binary and summarize the result.
///
/// This runs wasmtime's full component frontend: parse + validate + type-check
/// the component, resolve its linking structure to a flat initializer list,
/// and run FACT to synthesize fused adapter modules for every cross-component
/// lifted/lowered function pair.
pub fn translate(component_bytes: &[u8]) -> Result<Summary> {
    // `default_u32()` rather than `default_host()`: keeps native tests and the
    // wasm32 build byte-identical. FACT consults only `concurrency_support`
    // (true) and `debug_adapter_modules` (false) from tunables.
    let tunables = Tunables::default_u32();
    let mut validator = wasmparser::Validator::new_with_features(features());
    let mut types = ComponentTypesBuilder::new(&validator);
    let scope = ScopeVec::new();

    let (translation, modules) =
        Translator::new(&tunables, &mut validator, &mut types, &scope)
            .translate(component_bytes)?;

    // Distinguish embedded modules (slices of the input) from FACT adapters
    // (owned by the ScopeVec arena) by pointer containment.
    let base = component_bytes.as_ptr() as usize;
    let end = base + component_bytes.len();

    let mut module_summaries = Vec::new();
    let mut num_embedded = 0;
    let mut num_adapters = 0;
    for (idx, mt) in modules.iter() {
        let ptr = mt.wasm.as_ptr() as usize;
        let embedded = ptr >= base && ptr + mt.wasm.len() <= end;
        let kind = if embedded {
            num_embedded += 1;
            ModuleKind::Embedded
        } else {
            num_adapters += 1;
            ModuleKind::FactAdapter
        };
        let imports = mt
            .module
            .imports()
            .map(|(module, field, ty)| format!("{module}.{field}: {ty:?}"))
            .collect();
        let exports = mt
            .module
            .exports
            .iter()
            .map(|(atom, _)| mt.module.strings[*atom].to_string())
            .collect();
        module_summaries.push(ModuleSummary {
            index: idx.as_u32(),
            kind,
            offset_in_component: embedded.then_some(mt.wasm_module_offset),
            len: mt.wasm.len(),
            imports,
            exports,
        });
    }

    let initializers = translation
        .component
        .initializers
        .iter()
        .map(|i| format!("{i:?}"))
        .collect();
    let trampolines = translation
        .trampolines
        .iter()
        .map(|(idx, t)| format!("{}: {t:?}", idx.as_u32()))
        .collect();

    Ok(Summary {
        component_len: component_bytes.len(),
        num_embedded_modules: num_embedded,
        num_adapter_modules: num_adapters,
        modules: module_summaries,
        initializers,
        trampolines,
        num_runtime_instances: translation.component.num_runtime_instances,
        component_debug: format!("{:#?}", translation.component),
    })
}

/// C-ABI surface for the wasm32 build (used by the Deno driver).
///
/// Contract:
/// - `ts_alloc(len) -> ptr`: allocate `len` bytes (caller writes input here).
/// - `ts_translate(ptr, len, out_len: *mut usize) -> out_ptr`: translate the
///   component at `ptr..ptr+len`. Writes the output length to `*out_len` and
///   returns the output pointer; the output is UTF-8 JSON — either the
///   `Summary` or `{"error": "..."}`. (Out-param instead of a packed-u64
///   return so the same ABI is exercisable in native tests too.)
/// - `ts_dealloc(ptr, len)`: free a buffer from `ts_alloc`/`ts_translate`.
pub mod cabi {
    use super::translate;

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
        let json = match translate(bytes) {
            Ok(summary) => serde_json::to_string(&summary)
                .unwrap_or_else(|e| format!(r#"{{"error":"serialize failed: {e}"}}"#)),
            Err(e) => serde_json::to_string(&serde_json::json!({ "error": format!("{e:?}") }))
                .unwrap_or_else(|_| r#"{"error":"unknown"}"#.to_string()),
        };
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

