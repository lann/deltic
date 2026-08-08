//! Corpus inventory: run the shim over every component artifact produced by
//! `cargo run -p testgen` for the official suite directories and report what
//! translates, what is rejected, and (for the rejections) how the reason is
//! classified by `TranslateError::phase`.
//!
//! Usage:
//!   cargo run -p translator-shim --example suite-inventory [-- dir ...]
//!
//! This is a development/triage tool (PLAN.md §11), not a gate.

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Deserialize)]
struct WastJson {
    commands: Vec<Command>,
}

#[derive(Deserialize)]
struct Command {
    #[serde(rename = "type")]
    ty: String,
    line: u32,
    filename: Option<String>,
    kind: Option<String>,
    module_type: Option<String>,
}

fn main() {
    let dirs: Vec<String> = {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.is_empty() {
            ["binary", "validation", "linking", "resources"]
                .map(String::from)
                .to_vec()
        } else {
            args
        }
    };
    let root = format!("{}/../../harness/generated", env!("CARGO_MANIFEST_DIR"));

    for dir in dirs {
        let mut expect_ok = (0u32, 0u32); // (translated, failed)
        let mut expect_reject = (0u32, 0u32); // (rejected, wrongly accepted)
        let mut phases: BTreeMap<String, u32> = BTreeMap::new();
        let mut unexpected: Vec<String> = Vec::new();
        let mut features: BTreeMap<String, u32> = BTreeMap::new();

        let mut files: Vec<_> = std::fs::read_dir(format!("{root}/{dir}"))
            .expect("run `cargo run -p testgen` first")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();

        for path in files {
            let json: WastJson =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let stem = path.file_stem().unwrap().to_string_lossy().to_string();
            for cmd in &json.commands {
                let Some(file) = &cmd.filename else { continue };
                if cmd.kind.as_deref() != Some("component") {
                    continue;
                }
                if cmd.module_type.as_deref() != Some("binary") {
                    continue;
                }
                let bytes = std::fs::read(path.parent().unwrap().join(file)).unwrap();
                let result = translator_shim::translate(&bytes);
                let expect_success =
                    matches!(cmd.ty.as_str(), "module" | "module_definition");
                match (expect_success, result) {
                    (true, Ok(t)) => {
                        expect_ok.0 += 1;
                        let plan_json = serde_json::to_value(&t.plan).unwrap();
                        for tr in plan_json["trampolines"].as_array().unwrap() {
                            *features
                                .entry(format!(
                                    "trampoline:{}",
                                    tr["kind"].as_str().unwrap_or("?")
                                ))
                                .or_default() += 1;
                        }
                        if !t.plan.imports.is_empty() {
                            *features.entry("has-imports".into()).or_default() += 1;
                        }
                        for imp in &t.plan.imports {
                            *features
                                .entry(format!("import-kind:{}", imp.kind))
                                .or_default() += 1;
                            if !imp.path.is_empty() {
                                *features.entry("import-nested-path".into()).or_default() += 1;
                            }
                        }
                        if !t.plan.imported_resources.is_empty() {
                            *features.entry("imported-resources".into()).or_default() += 1;
                        }
                        if !t.adapters.is_empty() {
                            *features.entry("has-adapters".into()).or_default() += 1;
                        }
                    }
                    (true, Err(e)) => {
                        expect_ok.1 += 1;
                        *phases.entry(e.phase.to_string()).or_default() += 1;
                        unexpected.push(format!(
                            "  {stem}:{} [{}] {}: {}",
                            cmd.line, cmd.ty, e.phase, e.message
                        ));
                    }
                    (false, Err(e)) => {
                        expect_reject.0 += 1;
                        *phases.entry(e.phase.to_string()).or_default() += 1;
                    }
                    (false, Ok(_)) => {
                        expect_reject.1 += 1;
                        unexpected
                            .push(format!("  {stem}:{} [{}] WRONGLY ACCEPTED", cmd.line, cmd.ty));
                    }
                }
            }
        }

        println!("=== {dir} ===");
        println!(
            "  expected-valid:   {} translated, {} FAILED",
            expect_ok.0, expect_ok.1
        );
        println!(
            "  expected-invalid: {} rejected, {} WRONGLY ACCEPTED",
            expect_reject.0, expect_reject.1
        );
        println!("  rejection phases: {phases:?}");
        println!("  features seen:    {features:?}");
        for line in unexpected.iter().take(60) {
            println!("{line}");
        }
        if unexpected.len() > 60 {
            println!("  … and {} more", unexpected.len() - 60);
        }
        println!();
    }
}
