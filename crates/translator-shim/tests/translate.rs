//! Plan-v0 emission tests: the S0 spike assertions adapted to the plan
//! schema, plus determinism and a golden-ish shape test for the hello
//! fixture (contracts/plan-format.md).

use translator_shim::plan::{
    CoreDefJson, ExportDecl, Initializer, ModuleEntry, ResourceTableDecl, TrampolineDecl, TypeDecl,
    ValTypeJson, FORMAT_VERSION,
};
use translator_shim::{to_envelope_json, translate, Phase, Translation};

fn build(name: &str) -> Vec<u8> {
    let path = format!("{}/testdata/{name}.wat", env!("CARGO_MANIFEST_DIR"));
    wat::parse_file(&path).expect("testdata WAT should convert to binary")
}

/// Fixture components produced by `./examples/build.sh` (gitignored build
/// output). Tests that need them skip with a notice when absent.
fn fixture(name: &str) -> Option<Vec<u8>> {
    let path = format!(
        "{}/../../examples/guests/build/{name}.component.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(_) => {
            eprintln!("SKIP: fixture {path} missing — run ./examples/build.sh");
            None
        }
    }
}

fn adapter_entries(t: &Translation) -> Vec<&ModuleEntry> {
    t.plan
        .modules
        .iter()
        .filter(|m| matches!(m, ModuleEntry::Adapter { .. }))
        .collect()
}

/// (a) Trivial single-module component: exactly one embedded module, no
/// adapters, a sensible instantiation plan, and a lifted export.
#[test]
fn trivial() {
    let bytes = build("trivial");
    let t = translate(&bytes).unwrap();

    assert_eq!(t.plan.format_version, FORMAT_VERSION);
    assert_eq!(t.plan.modules.len(), 1);
    assert!(t.adapters.is_empty());
    match &t.plan.modules[0] {
        ModuleEntry::Embedded { offset, len } => {
            // Byte range sanity: the module must lie strictly inside the
            // component.
            assert!(*offset > 0 && *offset as usize + len <= bytes.len());
            // The range must actually contain a core wasm module.
            let slice = &bytes[*offset as usize..*offset as usize + len];
            assert_eq!(&slice[0..4], b"\0asm");
        }
        other => panic!("expected embedded module, got {other:?}"),
    }
    assert!(matches!(
        t.plan.initializers[0],
        Initializer::InstantiateModule { module: 0, instance: Some(0), .. }
    ));
    match &t.plan.exports[0] {
        ExportDecl::LiftedFunc { name, core_def, .. } => {
            assert_eq!(name, "add");
            assert!(matches!(core_def, CoreDefJson::Export { .. }));
        }
        other => panic!("expected lifted-func export, got {other:?}"),
    }
}

/// (b) Cross-instance call between two inline component instances: FACT must
/// generate at least one fused adapter module, instantiated with
/// `instance: null` and carrying a categorized intrinsics manifest.
#[test]
fn linked_generates_fact_adapter() {
    let bytes = build("linked");
    let t = translate(&bytes).unwrap();

    let embedded = t.plan.modules.len() - t.adapters.len();
    assert_eq!(embedded, 2, "modules: {:#?}", t.plan.modules);
    assert!(!t.adapters.is_empty());

    // Adapter artifacts are non-empty core wasm.
    for a in &t.adapters {
        assert!(!a.wasm.is_empty());
        assert_eq!(&a.wasm[0..4], b"\0asm");
        assert!(a.file.starts_with("adapters/") && a.file.ends_with(".wasm"));
    }

    // The plan instantiates the adapter with component instance null, and
    // args resolve 1:1 against the adapter's intrinsics manifest.
    let adapter_inits: Vec<_> = t
        .plan
        .initializers
        .iter()
        .filter(|i| matches!(i, Initializer::InstantiateModule { instance: None, .. }))
        .collect();
    assert_eq!(adapter_inits.len(), t.adapters.len());

    // Manifest categories cover the S0-observed intrinsic surface
    // (intrinsics.md §A): callee core-def, instance flags, task-may-block,
    // trap + enter/exit-sync-call trampolines.
    let manifests: Vec<String> = adapter_entries(&t)
        .iter()
        .flat_map(|m| match m {
            ModuleEntry::Adapter { intrinsics, .. } => {
                intrinsics.iter().map(|i| i.category.clone()).collect::<Vec<_>>()
            }
            _ => unreachable!(),
        })
        .collect();
    for expected in [
        "core-def",
        "instance-flags",
        "task-may-block",
        "trampoline:trap",
        "trampoline:enter-sync-call",
        "trampoline:exit-sync-call",
    ] {
        assert!(
            manifests.iter().any(|c| c == expected),
            "missing intrinsic category {expected}; got {manifests:?}"
        );
    }
}

/// (c1) Async-lifted export (callback ABI): the plan records the callback
/// extraction and the task-return trampoline with typed results.
#[test]
fn async_lift_translates() {
    let bytes = build("async-lift");
    let t = translate(&bytes).unwrap();

    assert!(t.adapters.is_empty());
    let task_return = t
        .plan
        .trampolines
        .iter()
        .find_map(|tr| match tr {
            TrampolineDecl::TaskReturn { results, options, .. } => Some((*results, *options)),
            _ => None,
        })
        .expect("task-return trampoline required");
    // The results reference points at a tuple entry in the types table.
    assert!(matches!(
        t.plan.types[task_return.0 as usize],
        TypeDecl::Value(ValTypeJson::Tuple { .. })
    ));
    assert!((task_return.1 as usize) < t.plan.canonical_options.len());
    assert!(
        t.plan
            .initializers
            .iter()
            .any(|i| matches!(i, Initializer::ExtractCallback { .. })),
        "initializers: {:#?}",
        t.plan.initializers
    );
}

/// (c2) Cross-component async: the async fusion trampolines
/// (prepare-call / sync-start-call / async-start-call) are all representable.
#[test]
fn async_linked_generates_async_adapters() {
    let bytes = build("async-linked");
    let t = translate(&bytes).unwrap();

    assert!(!t.adapters.is_empty());
    let kinds: Vec<&'static str> = t
        .plan
        .trampolines
        .iter()
        .map(|tr| match tr {
            TrampolineDecl::PrepareCall { .. } => "prepare-call",
            TrampolineDecl::SyncStartCall { .. } => "sync-start-call",
            TrampolineDecl::AsyncStartCall { .. } => "async-start-call",
            _ => "other",
        })
        .collect();
    for expected in ["prepare-call", "sync-start-call", "async-start-call"] {
        assert!(kinds.contains(&expected), "kinds: {kinds:?}");
    }
}

/// Determinism (plan-format.md): translating the same bytes twice yields a
/// byte-identical envelope (plan JSON + adapters).
#[test]
fn determinism() {
    for name in [
        "linked",
        "async-linked",
        "imports",
        "imported-resource",
        "relend-borrow",
        "transcode",
    ] {
        let bytes = build(name);
        let a = to_envelope_json(&translate(&bytes).unwrap()).unwrap();
        let b = to_envelope_json(&translate(&bytes).unwrap()).unwrap();
        assert_eq!(a, b, "{name}: nondeterministic envelope");
    }
    if let Some(bytes) = fixture("hello") {
        let a = to_envelope_json(&translate(&bytes).unwrap()).unwrap();
        let b = to_envelope_json(&translate(&bytes).unwrap()).unwrap();
        assert_eq!(a, b, "hello: nondeterministic envelope");
    }
}

/// Golden-ish shape test for the hello fixture (M0 exit criterion component):
/// wit-bindgen sync guest with strings, realloc and post-return.
#[test]
fn hello_plan_shape() {
    let Some(bytes) = fixture("hello") else { return };
    let t = translate(&bytes).unwrap();
    let plan = &t.plan;

    assert_eq!(plan.format_version, 0);
    assert_eq!(plan.producer.wasmtime_environ, "47.0.3");
    assert_eq!(plan.component.len, bytes.len());
    assert_eq!(plan.component.sha256.len(), 64);

    // One embedded module, no adapters.
    assert_eq!(plan.modules.len(), 1);
    assert!(t.adapters.is_empty());

    // Initializer program: instantiate, then extract memory/realloc/
    // post-return (wit-bindgen emits cabi_post_greet).
    let ops: Vec<&'static str> = plan
        .initializers
        .iter()
        .map(|i| match i {
            Initializer::InstantiateModule { .. } => "instantiate-module",
            Initializer::ExtractMemory { .. } => "extract-memory",
            Initializer::ExtractRealloc { .. } => "extract-realloc",
            Initializer::ExtractPostReturn { .. } => "extract-post-return",
            other => panic!("unexpected initializer {other:?}"),
        })
        .collect();
    assert_eq!(
        ops,
        [
            "instantiate-module",
            "extract-memory",
            "extract-realloc",
            "extract-post-return"
        ]
    );

    // Canonical options: utf8 strings, memory+realloc+postReturn wired, sync,
    // and the flat core type of `greet` (two params, retptr result).
    assert_eq!(plan.canonical_options.len(), 1);
    let opts = &plan.canonical_options[0];
    assert_eq!(opts.string_encoding, "utf8");
    assert_eq!(opts.memory, Some(0));
    assert_eq!(opts.realloc, Some(0));
    assert_eq!(opts.post_return, Some(0));
    assert_eq!(opts.callback, None);
    assert!(!opts.r#async);
    assert_eq!(opts.core_type.params, ["i32", "i32"]);
    assert_eq!(opts.core_type.results, ["i32"]);

    // Types: exactly the greet function type, string -> string, param
    // label preserved.
    assert_eq!(plan.types.len(), 1);
    match &plan.types[0] {
        TypeDecl::Func { params, results, r#async, .. } => {
            assert_eq!(params.len(), 1);
            assert_eq!(params[0].label, "name");
            assert!(matches!(params[0].r#type, ValTypeJson::String));
            assert_eq!(results.len(), 1);
            assert!(matches!(results[0], ValTypeJson::String));
            assert!(!r#async);
        }
        other => panic!("expected func type, got {other:?}"),
    }

    // Export surface: exactly `greet`, wired to core export "greet".
    assert_eq!(plan.imports.len(), 0);
    assert_eq!(plan.exports.len(), 1);
    match &plan.exports[0] {
        ExportDecl::LiftedFunc { name, core_def, options, r#type } => {
            assert_eq!(name, "greet");
            assert_eq!(*options, 0);
            assert_eq!(*r#type, 0);
            match core_def {
                CoreDefJson::Export { instance, item } => {
                    assert_eq!(*instance, 0);
                    assert_eq!(item.name, "greet");
                    assert_eq!(item.space, "func");
                }
                other => panic!("expected export core def, got {other:?}"),
            }
        }
        other => panic!("expected lifted-func, got {other:?}"),
    }

    assert!(plan.world_digest.starts_with("sha256:"));
}

/// The whole M0 fixture corpus must map without hitting unmapped variants
/// (fail-loudly contract): hello, values, resources.
#[test]
fn m0_fixture_corpus_translates() {
    for name in ["hello", "values", "resources"] {
        let Some(bytes) = fixture(name) else { continue };
        let t = translate(&bytes).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert!(!t.plan.exports.is_empty(), "{name}: no exports mapped");
        // Envelope serialization must succeed for the corpus.
        to_envelope_json(&t).unwrap();
    }
}

/// The resources fixture exercises the resource surface: resource
/// initializer with dtor, resource trampolines, own/borrow types, and an
/// exported instance with a type export.
#[test]
fn resources_plan_shape() {
    let Some(bytes) = fixture("resources") else { return };
    let t = translate(&bytes).unwrap();
    let plan = &t.plan;

    // `resource` initializer with a dtor and i32 rep.
    let resource = plan
        .initializers
        .iter()
        .find_map(|i| match i {
            Initializer::Resource { rep, dtor, .. } => Some((rep.clone(), dtor.is_some())),
            _ => None,
        })
        .expect("resource initializer");
    assert_eq!(resource.0, "i32");
    assert!(resource.1, "resource dtor expected");

    // resource-drop / resource-new / resource-rep trampolines.
    let mut kinds: Vec<&str> = plan
        .trampolines
        .iter()
        .map(|tr| match tr {
            TrampolineDecl::ResourceNew { .. } => "new",
            TrampolineDecl::ResourceRep { .. } => "rep",
            TrampolineDecl::ResourceDrop { .. } => "drop",
            _ => "other",
        })
        .collect();
    kinds.sort();
    kinds.dedup();
    assert_eq!(kinds, ["drop", "new", "rep"]);

    // Resource table + own/borrow types referencing it.
    assert!(!plan.resource_tables.is_empty());
    let types_json = serde_json::to_string(&plan.types).unwrap();
    assert!(types_json.contains(r#""kind":"own""#), "{types_json}");
    assert!(types_json.contains(r#""kind":"borrow""#), "{types_json}");

    // The counters interface is an exported instance with a type export.
    let instance = plan
        .exports
        .iter()
        .find_map(|e| match e {
            ExportDecl::Instance { name, exports } if name.contains("counters") => Some(exports),
            _ => None,
        })
        .expect("exported counters instance");
    assert!(instance
        .iter()
        .any(|e| matches!(e, ExportDecl::Type { .. })));
    assert!(instance
        .iter()
        .any(|e| matches!(e, ExportDecl::LiftedFunc { .. })));
}

/// wit-bindgen 0.60 async guests use `context.{get,set}` which wasmtime 47
/// models as `CoreDef::UnsafeIntrinsic` — rejected by plan v0 per contract.
/// Lock the failure mode (clear error, not panic/silent drop).
#[test]
fn async_probe_rejected_with_unsafe_intrinsic_error() {
    let Some(bytes) = fixture("async-probe") else { return };
    let err = translate(&bytes).unwrap_err();
    let msg = format!("{err:?}");
    assert!(
        msg.contains("UnsafeIntrinsic"),
        "expected UnsafeIntrinsic rejection, got: {msg}"
    );
}

/// Invalid input must error, not panic.
#[test]
fn invalid_component_errors() {
    assert!(translate(b"not a component").is_err());
    // A plain core module is not a component either.
    let core = wat::parse_str("(module)").unwrap();
    assert!(translate(&core).is_err());
}

/// The three-component re-lend fixture must produce the transfer intrinsics
/// the runtime's borrow bookkeeping depends on: a resource table per
/// component instance, plus own *and* borrow transfers.
#[test]
fn relend_fixture_shape() {
    let bytes = build("relend-borrow");
    let t = translate(&bytes).unwrap();

    // Four component instances (outer + $Def + $Mid + $App) each get their
    // own table for the single resource (ResourceIndex 0).
    assert_eq!(t.plan.resource_tables.len(), 4);
    for table in &t.plan.resource_tables {
        match table {
            ResourceTableDecl::Concrete { resource, .. } => assert_eq!(*resource, 0),
            other => panic!("expected concrete resource table, got {other:?}"),
        }
    }
    let kinds: Vec<&str> = t
        .plan
        .trampolines
        .iter()
        .map(|t| match t {
            TrampolineDecl::ResourceTransferOwn { .. } => "own",
            TrampolineDecl::ResourceTransferBorrow { .. } => "borrow",
            _ => "other",
        })
        .collect();
    assert!(kinds.contains(&"own"), "{kinds:?}");
    assert!(kinds.contains(&"borrow"), "{kinds:?}");
    // Two fused adapters: $App -> $Mid and $Mid -> $Def.
    assert_eq!(t.adapters.len(), 2);
}

/// A cross-encoding string transfer must surface as a `Transcoder`
/// trampoline carrying the `Transcode::desc()` op name and the two
/// `RuntimeMemoryIndex`es the runtime needs to do the copy
/// (contracts/intrinsics.md §B "M1").
#[test]
fn transcoder_trampoline_shape() {
    let bytes = build("transcode");
    let t = translate(&bytes).unwrap();

    let transcoders: Vec<&TrampolineDecl> = t
        .plan
        .trampolines
        .iter()
        .filter(|t| matches!(t, TrampolineDecl::Transcoder { .. }))
        .collect();
    assert_eq!(transcoders.len(), 1, "{:#?}", t.plan.trampolines);
    match transcoders[0] {
        TrampolineDecl::Transcoder {
            op,
            from,
            from64,
            to,
            to64,
            ..
        } => {
            // utf16 caller -> utf8 callee.
            assert_eq!(op, "utf16-to-utf8");
            assert!(!from64 && !to64, "memory64 is out of scope");
            assert_ne!(from, to, "source and destination memories differ");
        }
        other => panic!("expected a transcoder, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Structured verdicts (src/error.rs; contracts v0.2 proposal)
// ---------------------------------------------------------------------------

/// Malformed bytes and invalid components are both `validation`: the shim's
/// judgment about the *input*. This is the only phase a conformance runner
/// may score as a correct `assert_invalid` / `assert_malformed` rejection.
#[test]
fn verdict_phase_validation() {
    for bytes in [
        b"not a component".to_vec(),
        wat::parse_str("(module)").unwrap(),
        // Valid binary structure, invalid types: lift a core func with the
        // wrong signature.
        wat::parse_str(
            r#"(component
                 (core module $m (func (export "f")))
                 (core instance $i (instantiate $m))
                 (func (export "f") (result u32)
                   (canon lift (core func $i "f"))))"#,
        )
        .unwrap(),
        // Core function *body* validation: wasmtime defers this to its
        // compiler backend, so the shim runs the deferred validators itself
        // (official suite test/validation/core-modules.wast:24).
        wat::parse_str(r#"(component (core module (func i32.add)))"#).unwrap(),
    ] {
        let e = translate(&bytes).unwrap_err();
        assert_eq!(e.phase, Phase::Validation, "{e}");
        assert!(!e.message.is_empty());
    }
}

/// A valid component the plan format cannot express is `unsupported` — never
/// `validation`, which would be a false claim about the component.
#[test]
fn verdict_phase_unsupported() {
    let bytes = wat::parse_str(
        r#"(component (core module $m) (export "m" (core module $m)))"#,
    )
    .unwrap();
    let e = translate(&bytes).unwrap_err();
    assert_eq!(e.phase, Phase::Unsupported, "{e}");
    assert!(e.message.contains("module exports"), "{e}");
}

// ---------------------------------------------------------------------------
// Component imports (plan-format.md v0.1 amendment #4) and imported resources
// ---------------------------------------------------------------------------

/// Direct function imports and instance imports: the latter produce one plan
/// import per *leaf*, sharing the instance's name and carrying the walk in
/// `path`.
#[test]
fn imports_carry_instance_paths() {
    let bytes = build("imports");
    let t = translate(&bytes).unwrap();

    let names: Vec<(String, Vec<String>, &str)> = t
        .plan
        .imports
        .iter()
        .map(|i| (i.name.clone(), i.path.clone(), i.kind))
        .collect();
    assert_eq!(
        names,
        vec![
            ("log".to_string(), vec![], "func"),
            ("host:api/math".to_string(), vec!["add".to_string()], "func"),
            ("host:api/math".to_string(), vec!["greet".to_string()], "func"),
        ],
        "imports: {names:?}"
    );
    // Every import is reached through a lower-import initializer + trampoline.
    let lowered = t
        .plan
        .initializers
        .iter()
        .filter(|i| matches!(i, Initializer::LowerImport { .. }))
        .count();
    assert_eq!(lowered, 3);
    assert_eq!(
        t.plan
            .trampolines
            .iter()
            .filter(|t| matches!(t, TrampolineDecl::LowerImport { .. }))
            .count(),
        3
    );
    assert!(t.plan.imported_resources.is_empty());
}

/// An imported resource type: `importedResources` back-references the plan
/// import, and the resource table's `resource` is the *component-wide*
/// ResourceIndex (0 here — imported resources come first).
#[test]
fn imported_resources_are_emitted() {
    let bytes = build("imported-resource");
    let t = translate(&bytes).unwrap();

    assert_eq!(t.plan.imported_resources.len(), 1);
    let import_idx = t.plan.imported_resources[0].import as usize;
    let imp = &t.plan.imports[import_idx];
    assert_eq!(imp.kind, "resource");
    assert_eq!(imp.name, "host:api/res");
    assert_eq!(imp.path, vec!["R".to_string()]);

    // ResourceIndex 0 is the imported resource; no defined resources exist,
    // so no `resource` initializer is emitted.
    assert_eq!(t.plan.resource_tables.len(), 1);
    match &t.plan.resource_tables[0] {
        ResourceTableDecl::Concrete { resource, .. } => assert_eq!(*resource, 0),
        other => panic!("expected concrete resource table, got {other:?}"),
    }
    assert!(
        !t.plan
            .initializers
            .iter()
            .any(|i| matches!(i, Initializer::Resource { .. })),
        "no resource is *defined* by this component"
    );
    // resource.drop on an imported type still needs its trampoline.
    assert!(
        t.plan
            .trampolines
            .iter()
            .any(|t| matches!(t, TrampolineDecl::ResourceDrop { .. }))
    );
}
