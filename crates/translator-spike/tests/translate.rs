use translator_spike::{translate, ModuleKind, Summary};

fn build(name: &str) -> Vec<u8> {
    let path = format!("{}/testdata/{name}.wat", env!("CARGO_MANIFEST_DIR"));
    wat::parse_file(&path).expect("testdata WAT should convert to binary")
}

fn adapters(s: &Summary) -> Vec<&translator_spike::ModuleSummary> {
    s.modules
        .iter()
        .filter(|m| m.kind == ModuleKind::FactAdapter)
        .collect()
}

/// (a) Trivial single-module component: exactly one embedded module, no
/// adapters, and a sensible instantiation plan.
#[test]
fn trivial() {
    let bytes = build("trivial");
    let s = translate(&bytes).unwrap();
    println!("{s:#?}");

    assert_eq!(s.num_embedded_modules, 1);
    assert_eq!(s.num_adapter_modules, 0);
    let m = &s.modules[0];
    assert_eq!(m.kind, ModuleKind::Embedded);
    // Byte range sanity: the module must lie strictly inside the component.
    let off = m.offset_in_component.unwrap() as usize;
    assert!(off > 0 && off + m.len <= s.component_len);
    assert!(m.exports.iter().any(|e| e == "add"));
    // One InstantiateModule initializer for the single core module.
    assert!(
        s.initializers
            .iter()
            .any(|i| i.contains("InstantiateModule")),
        "no InstantiateModule in {:#?}",
        s.initializers
    );
    // The lifted export shows up in the flattened component structure.
    assert!(s.component_debug.contains("add"));
}

/// (b) Cross-instance call between two inline component instances: FACT must
/// generate at least one fused adapter module, exported + wired through the
/// instantiation plan.
#[test]
fn linked_generates_fact_adapter() {
    let bytes = build("linked");
    let s = translate(&bytes).unwrap();
    println!("{s:#?}");

    assert_eq!(s.num_embedded_modules, 2, "modules: {:#?}", s.modules);
    assert!(
        s.num_adapter_modules >= 1,
        "expected >=1 FACT adapter, got modules: {:#?}",
        s.modules
    );

    let ads = adapters(&s);
    for a in &ads {
        // Adapter modules are synthesized: no offset in the component, and
        // they must be non-empty core wasm exporting the fused adapter funcs.
        assert!(a.offset_in_component.is_none());
        assert!(a.len > 0);
        assert!(
            a.exports.iter().any(|e| e.starts_with("adapter")),
            "adapter exports: {:?}",
            a.exports
        );
    }
    // Sync-to-sync fused calls import the enter/exit bookkeeping intrinsics
    // (wasmtime 47 with concurrency_support on).
    let all_adapter_imports: Vec<_> = ads.iter().flat_map(|a| a.imports.iter()).collect();
    assert!(
        all_adapter_imports
            .iter()
            .any(|i| i.contains("callee")),
        "adapter should import the lifted callee: {all_adapter_imports:?}"
    );

    // The plan must instantiate the adapter module (an InstantiateModule
    // initializer with component instance `None` per wasmtime docs).
    assert!(
        s.initializers
            .iter()
            .any(|i| i.contains("InstantiateModule") && i.ends_with("None)")),
        "no adapter-module instantiation in plan: {:#?}",
        s.initializers
    );
}

/// (c1) Async-lifted export (callback ABI): translation must succeed with the
/// async feature set, and the plan must record the callback + task-return
/// machinery.
#[test]
fn async_lift_translates() {
    let bytes = build("async-lift");
    let s = translate(&bytes).unwrap();
    println!("{s:#?}");

    assert_eq!(s.num_embedded_modules, 1);
    // No cross-component call here => no adapter needed.
    assert_eq!(s.num_adapter_modules, 0);
    // task.return is a host trampoline in wasmtime's model.
    assert!(
        s.trampolines.iter().any(|t| t.contains("TaskReturn")),
        "trampolines: {:#?}",
        s.trampolines
    );
    // The async callback must be extracted into the runtime plan.
    assert!(
        s.initializers.iter().any(|i| i.contains("ExtractCallback")),
        "initializers: {:#?}",
        s.initializers
    );
}

/// (c2) Cross-component async: sync-lower/async-lift and async-lower/
/// async-lift fusions must both produce FACT adapters wired with the async
/// intrinsics (prepare-call / start-call).
#[test]
fn async_linked_generates_async_adapters() {
    let bytes = build("async-linked");
    let s = translate(&bytes).unwrap();
    println!("{s:#?}");

    assert_eq!(s.num_embedded_modules, 3, "modules: {:#?}", s.modules); // MA, MEM, MB
    assert!(
        s.num_adapter_modules >= 1,
        "expected FACT adapters, got: {:#?}",
        s.modules
    );

    let ads = adapters(&s);
    let all_imports: Vec<String> = ads
        .iter()
        .flat_map(|a| a.imports.iter().cloned())
        .collect();
    // Async fusion paths import the prepare/start-call intrinsics. Observed
    // naming (wasmtime 47): `sync.[prepare-call]adapterN`,
    // `sync.[start-call]adapterN` (sync lower of async lift) and
    // `async.[start-call]adapterN` (async lower).
    assert!(
        all_imports.iter().any(|i| i.contains("[prepare-call]")),
        "adapter imports: {all_imports:#?}"
    );
    assert!(
        all_imports.iter().any(|i| i.starts_with("sync.[start-call]")),
        "adapter imports: {all_imports:#?}"
    );
    assert!(
        all_imports.iter().any(|i| i.starts_with("async.[start-call]")),
        "adapter imports: {all_imports:#?}"
    );
}

/// The summary must serialize to JSON (the wasm32 C-ABI contract).
#[test]
fn summary_serializes_to_json() {
    let bytes = build("linked");
    let s = translate(&bytes).unwrap();
    let json = serde_json::to_string(&s).unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(v["num_adapter_modules"].as_u64().unwrap() >= 1);
}

/// Invalid input must error, not panic.
#[test]
fn invalid_component_errors() {
    assert!(translate(b"not a component").is_err());
    // A plain core module is not a component either.
    let core = wat::parse_str("(module)").unwrap();
    assert!(translate(&core).is_err());
}
