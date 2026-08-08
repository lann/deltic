//! Native exercise of the exact C-ABI sequence the Deno driver performs:
//! alloc -> write -> translate -> read JSON -> dealloc(out) -> dealloc(in).
//!
//! Running this in debug (with glibc malloc + all Rust debug assertions)
//! double-checks that the buffer-ownership contract is sound independent of
//! the wasm32/dlmalloc build.
use translator_spike::cabi::{ts_alloc, ts_dealloc, ts_translate};

fn roundtrip(name: &str) -> String {
    let path = format!("{}/testdata/{name}.wat", env!("CARGO_MANIFEST_DIR"));
    let comp = wat::parse_file(&path).unwrap();
    unsafe {
        let ptr = ts_alloc(comp.len());
        std::ptr::copy_nonoverlapping(comp.as_ptr(), ptr, comp.len());
        let mut out_len: usize = 0;
        let out_ptr = ts_translate(ptr, comp.len(), &mut out_len);
        let json =
            std::str::from_utf8(std::slice::from_raw_parts(out_ptr, out_len))
                .unwrap()
                .to_string();
        ts_dealloc(out_ptr, out_len);
        ts_dealloc(ptr, comp.len());
        json
    }
}

#[test]
fn cabi_roundtrip_all_testdata() {
    for name in ["trivial", "linked", "async-lift", "async-linked"] {
        let json = roundtrip(name);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            v["error"].is_null(),
            "{name}: unexpected error: {}",
            v["error"]
        );
        assert!(v["num_embedded_modules"].as_u64().unwrap() >= 1, "{name}");
    }
    // Repeat to stress allocator reuse the way the deno --bench loop does.
    for _ in 0..20 {
        roundtrip("linked");
    }
}
