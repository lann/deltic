//! Cross-language digest equality is validated in
//! `runtime/tests/digest_test.ts` (against checked-in plan.json fixtures —
//! see that file for regen instructions). These are the Rust-side unit
//! tests: digest computation is stable, order-independent, and produces the
//! expected canonical shape for each of the three sync fixture worlds.

use std::path::Path;

use bindgen::digest::{compute, resolve_world};

fn wit_path(name: &str) -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR = crates/bindgen
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/guests")
        .join(name)
        .join("wit")
}

#[test]
fn hello_digest_is_stable_and_matches_expected_shape() {
    let (resolve, world) = resolve_world(&wit_path("hello"), Some("hello")).unwrap();
    let d = compute(&resolve, world).unwrap();
    assert_eq!(
        d.canonical_json,
        r#"{"cewd":1,"exports":[{"func":{"async":false,"params":[{"kind":"string"}],"results":[{"kind":"string"}]},"kind":"func","name":"greet"}],"imports":[]}"#
    );
    // Recomputing must be byte-identical (determinism).
    let d2 = compute(&resolve, world).unwrap();
    assert_eq!(d.digest, d2.digest);
    assert_eq!(d.digest, "sha256:04ae5eb2633ff22f5af8c5e9234c18d089e80a99e04b0946929f0a2e3f5ad7c9");
}

#[test]
fn values_digest_is_stable() {
    let (resolve, world) = resolve_world(&wit_path("values"), Some("values")).unwrap();
    let d = compute(&resolve, world).unwrap();
    assert_eq!(
        d.digest,
        "sha256:e0791536cb4b9731057b82831150611eed64f22d665130a02f247d3227e2e4a7"
    );
    // Exports are sorted by name in the canonical form, independent of WIT
    // declaration order.
    let v: serde_json::Value = serde_json::from_str(&d.canonical_json).unwrap();
    let names: Vec<&str> = v["exports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "exports must be name-sorted in canonical form");
}

#[test]
fn resources_digest_resolves_own_borrow_by_qualified_name() {
    let (resolve, world) = resolve_world(&wit_path("resources"), Some("resources")).unwrap();
    let d = compute(&resolve, world).unwrap();
    assert_eq!(
        d.digest,
        "sha256:b518eda0084b7bbf4e490aa50137cd579b443e1fe6a2c5d52132f2b020b02dc8"
    );
    assert!(
        d.canonical_json.contains(
            "\"resource\":\"component-engine:resources/counters/counter\""
        ),
        "own/borrow must reference the resource by qualified name, not table index: {}",
        d.canonical_json
    );
    // No raw resource-table index should leak into the digest.
    assert!(!d.canonical_json.contains("\"resource\":0"));
    assert!(!d.canonical_json.contains("\"resource\":1"));
}

#[test]
fn type_table_order_does_not_affect_digest() {
    // Two WIT sources with the same functions declared in different order,
    // and unrelated type declarations interleaved differently, must digest
    // identically: the digest is built from a fresh recursive walk of the
    // reachable surface, not from either side's flat type table order.
    let a = r#"
        package t:a;
        world w {
            record r1 { x: u32 }
            record r2 { y: string }
            export f1: func(v: r1) -> r1;
            export f2: func(v: r2) -> r2;
        }
    "#;
    let b = r#"
        package t:a;
        world w {
            record r2 { y: string }
            record r1 { x: u32 }
            export f2: func(v: r2) -> r2;
            export f1: func(v: r1) -> r1;
        }
    "#;
    let da = digest_from_str(a);
    let db = digest_from_str(b);
    assert_eq!(da, db);
}

#[test]
fn renaming_a_param_label_does_not_affect_digest() {
    // Deliberate normalization decision (see digest.rs module docs): param
    // labels are excluded, since this runtime calls positionally.
    let a = r#"
        package t:b;
        world w { export f: func(alpha: u32) -> u32; }
    "#;
    let b = r#"
        package t:b;
        world w { export f: func(beta: u32) -> u32; }
    "#;
    assert_eq!(digest_from_str(a), digest_from_str(b));
}

#[test]
fn renaming_a_record_field_does_change_the_digest() {
    let a = r#"
        package t:c;
        world w { record r { x: u32 } export f: func(v: r) -> r; }
    "#;
    let b = r#"
        package t:c;
        world w { record r { y: u32 } export f: func(v: r) -> r; }
    "#;
    assert_ne!(digest_from_str(a), digest_from_str(b));
}

#[test]
fn reordering_record_fields_does_change_the_digest() {
    // Field order is ABI-relevant (flattening order) — not sorted away.
    let a = r#"
        package t:d;
        world w { record r { x: u32, y: string } export f: func(v: r) -> r; }
    "#;
    let b = r#"
        package t:d;
        world w { record r { y: string, x: u32 } export f: func(v: r) -> r; }
    "#;
    assert_ne!(digest_from_str(a), digest_from_str(b));
}

fn digest_from_str(src: &str) -> String {
    let dir = tempdir_with_wit(src);
    let (resolve, world) = resolve_world(&dir, None).unwrap();
    compute(&resolve, world).unwrap().digest
}

fn tempdir_with_wit(src: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "bindgen-digest-test-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    std::fs::create_dir_all(dir.join("wit")).unwrap();
    std::fs::write(dir.join("wit").join("world.wit"), src).unwrap();
    dir.join("wit")
}

fn rand_suffix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos() as u64
}
