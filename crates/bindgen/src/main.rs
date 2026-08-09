//! `bindgen` CLI (PLAN.md §9 kickoff): WIT world -> typed TS facade +
//! embedded canonical digest.
//!
//! ```text
//! bindgen <wit-path> [--world <name>] --out <file.ts>
//! bindgen digest <wit-path> [--world <name>]   # print canonical digest only
//! ```

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "bindgen", about = "deltic WIT -> TS bindgen (kickoff)")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Command>,

    /// WIT file or directory (used when no subcommand is given: `generate`).
    wit_path: Option<PathBuf>,

    #[arg(long)]
    world: Option<String>,

    #[arg(long)]
    out: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Generate the typed TS facade for a world.
    Generate {
        wit_path: PathBuf,
        #[arg(long)]
        world: Option<String>,
        #[arg(long)]
        out: PathBuf,
    },
    /// Print only the canonical digest (debugging / cross-language tests).
    Digest {
        wit_path: PathBuf,
        #[arg(long)]
        world: Option<String>,
        /// Also print the canonical JSON that was hashed.
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Some(Command::Generate {
            wit_path,
            world,
            out,
        }) => generate(&wit_path, world.as_deref(), &out),
        Some(Command::Digest {
            wit_path,
            world,
            json,
        }) => print_digest(&wit_path, world.as_deref(), json),
        None => {
            let wit_path = cli.wit_path.context("missing <wit-path>")?;
            let out = cli.out.context("missing --out <file.ts>")?;
            generate(&wit_path, cli.world.as_deref(), &out)
        }
    }
}

fn generate(wit_path: &std::path::Path, world: Option<&str>, out: &std::path::Path) -> Result<()> {
    let (resolve, world_id) = bindgen::digest::resolve_world(wit_path, world)?;
    let (_canonical_json, digest, ts) = bindgen::codegen::generate_with_digest(&resolve, world_id)?;
    std::fs::write(out, ts).with_context(|| format!("writing {}", out.display()))?;
    eprintln!("wrote {} (digest {digest})", out.display());
    Ok(())
}

fn print_digest(wit_path: &std::path::Path, world: Option<&str>, json: bool) -> Result<()> {
    let (resolve, world_id) = bindgen::digest::resolve_world(wit_path, world)?;
    let d = bindgen::digest::compute(&resolve, world_id)?;
    if json {
        println!("{}", d.canonical_json);
    }
    println!("{}", d.digest);
    Ok(())
}
