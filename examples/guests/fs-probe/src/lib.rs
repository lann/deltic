//! `fs-probe` guest: a std::fs battery over the preopen at "/" —
//! create/write/read/append/seek/list/rename/metadata/delete plus the
//! NotFound error path. Built for wasm32-wasip2, so every operation
//! travels wasi-libc -> preview1 adapter -> `wasi:filesystem@0.2` +
//! `wasi:io@0.2` (via-stream reads/writes, blocking stream ops) — the
//! real linkage of a ported CLI program, end to end against the host
//! provider under test.

wit_bindgen::generate!({
    world: "fs-probe",
});

use std::fs;
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};

struct Component;

fn step<T, E: std::fmt::Display>(what: &str, r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| format!("{what}: {e}"))
}

fn check(what: &str, cond: bool) -> Result<(), String> {
    if cond { Ok(()) } else { Err(format!("{what}: check failed")) }
}

impl Guest for Component {
    fn run() -> Result<String, String> {
        // mkdir + create/write.
        step("create_dir /work", fs::create_dir("/work"))?;
        {
            let mut f = step("create /work/a.txt", fs::File::create("/work/a.txt"))?;
            step("write", f.write_all(b"hello from wasip2"))?;
        }

        // Read back whole-file.
        let text = step("read_to_string", fs::read_to_string("/work/a.txt"))?;
        check("round-trip", text == "hello from wasip2")?;

        // Append.
        {
            let mut f = step(
                "open append",
                fs::OpenOptions::new().append(true).open("/work/a.txt"),
            )?;
            step("append", f.write_all(b"!"))?;
        }
        let meta = step("metadata", fs::metadata("/work/a.txt"))?;
        check("appended size", meta.len() == 18)?;
        check("is_file", meta.is_file())?;

        // Seek + partial read.
        {
            let mut f = step("open ro", fs::File::open("/work/a.txt"))?;
            step("seek", f.seek(SeekFrom::Start(6)))?;
            let mut tail = String::new();
            step("read tail", f.read_to_string(&mut tail))?;
            check("seeked tail", tail == "from wasip2!")?;
        }

        // Directory listing.
        let mut names: Vec<String> = step("read_dir", fs::read_dir("/work"))?
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        names.sort();
        check("listing", names == ["a.txt"])?;

        // Rename, then the old name must be gone.
        step("rename", fs::rename("/work/a.txt", "/work/b.txt"))?;
        check("old gone", fs::metadata("/work/a.txt").is_err())?;
        check(
            "renamed content",
            step("read renamed", fs::read_to_string("/work/b.txt"))? == "hello from wasip2!",
        )?;

        // The error path: NotFound must arrive as NotFound (error-code
        // enum -> errno round-trip through the adapter).
        match fs::File::open("/work/missing") {
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            other => return Err(format!("expected NotFound, got {other:?}")),
        }

        // Cleanup: unlink + rmdir.
        step("remove_file", fs::remove_file("/work/b.txt"))?;
        step("remove_dir", fs::remove_dir("/work"))?;
        check("dir gone", fs::metadata("/work").is_err())?;

        Ok("fs probe ok".to_string())
    }
}

export!(Component);
