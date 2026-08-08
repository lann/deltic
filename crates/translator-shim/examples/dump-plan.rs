fn main() {
    let path = std::env::args().nth(1).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    match translator_shim::translate(&bytes) {
        Ok(t) => {
            let json = translator_shim::to_envelope_json(&t).unwrap();
            eprintln!("{path}: OK plan bytes={} adapters={} trampolines={} inits={} exports={}",
                serde_json::to_string(&t.plan).unwrap().len(), t.adapters.len(),
                t.plan.trampolines.len(), t.plan.initializers.len(), t.plan.exports.len());
            if std::env::args().nth(2).as_deref() == Some("--full") {
                println!("{json}");
            }
        }
        Err(e) => {
            eprintln!("{path}: FAIL {e:?}");
            std::process::exit(1);
        }
    }
}
