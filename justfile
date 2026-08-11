# The orchestration surface: repo-wide recipes here, the CI job bodies in
# .github/justfile (the `gha` module) — each CI job runs exactly one
# `gha::` recipe, so `just ci` is exactly CI. Recipe bodies are the exact
# commands (AGENTS.md "Gates" maps onto them 1:1); comments that used to
# live on workflow steps live on the recipes now.

mod gha '.github'

default:
    @just --list

# The canary lanes are findings-only crons (`gha::canary`, `gha::canary-arm`).
# Exactly the CI jobs: the required `core` matrix + the post-merge `browser` job.
ci: (gha::core) (gha::browser)

# Includes the consumer smokes CI cannot run (they need the polymorph
# checkouts; docs/consumers.md).
# The full pre-commit pass (AGENTS.md "Gates"): everything.
gates: build test-rust test-protocol test-runtime test-wasi-shims test-ct-runner test-bundle examples test-translate conformance sched-seeds test-ports test-webrtc shells browsers websocket-conformance smoke-tls smoke-c0

# Fast sanity: builds + native tests + type-checks, no suites.
check: build test-rust
    cd protocol && deno task check
    cd runtime && deno task check
    cd wasi-shims && deno task check
    cd ct-runner && deno task check

# ----- builders ---------------------------------------------------------------

build:
    cargo build --workspace

# The translator shim wasm: every Deno suite below loads this artifact.
# Size-tuned (S0's figures: ~1.8 MB raw / ~0.5 MB gzip, vs 3.8 MB stock
# release): the shim is a shipped asset (issue #16), so the wasm build opts
# into z/lto/abort via scoped env vars — the workspace [profile.release]
# stays stock so testgen/bindgen keep fast builds and fast corpus runs.
# Semantics are untouched (same crate, same deps); the conformance gate is
# the check that matters and runs on this artifact.
shim:
    CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
    CARGO_PROFILE_RELEASE_LTO=fat \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_PROFILE_RELEASE_PANIC=abort \
    CARGO_PROFILE_RELEASE_STRIP=symbols \
    cargo build -p translator-shim --target wasm32-unknown-unknown --release
    cp target/wasm32-unknown-unknown/release/translator_shim.wasm translator/translator_shim.wasm

# wasmtime CLI is optional in build.sh (smoke run only when present).
# Guest fixture components (examples/guests/build/, gitignored): the
# runtime e2e suites and ct-runner's fixture tests need them.
fixtures:
    ./examples/build.sh

# The consumer-facing embedder examples (examples/README.md): build each
# guest component and run its self-checking host. These double as living
# documentation of the embedder API — CI runs them so they cannot rot.
examples: shim
    ./examples/hello-world/run.sh
    ./examples/kitchen-sink/run.sh

# Build-time translation CLI (tools/translate, embedder-api A4): translate
# to an envelope, reconstitute artifacts without a translator, verify the
# mismatched-pair refusal.
test-translate: shim
    deno test --allow-read --allow-write=/tmp --allow-run tools/translate/translate_test.ts
    cd translator && deno task check && deno task test

# Rehearsal finding: 20 runtime e2e tests self-skip when it is absent —
# generation must precede the runtime suite (318/0/3 with; 298/0/23 without).
# The conformance corpus (harness/generated/).
corpus:
    cd harness && deno task gen

# ----- core suites ------------------------------------------------------------

test-rust:
    cargo test -p translator-shim -p bindgen -p testgen

test-runtime: shim fixtures corpus
    cd runtime && deno task check && deno task test

# The brand vocabulary (contracts/embedder-api.md amendment A8): dependency-
# free, so this is the one Deno suite that needs no build artifacts at all.
test-protocol:
    cd protocol && deno task test

test-wasi-shims:
    cd wasi-shims && deno task test

test-ct-runner: shim fixtures
    cd ct-runner && deno task test

# The embedder-bundle release-asset gate (deltic-embedder.mjs:
# build + shape checks for tools/release-bundle/entry.ts).
# `dual_copy_test.ts` rides here because the bundle IS the second runtime copy
# (amendment A8 / issue #83): it is the only way to get two genuinely distinct
# copies in one process — query-string cache-busting does not, since relative
# imports below the entry resolve to the same cached modules.
test-bundle: shim
    deno test -A tools/release-bundle/

# The harness task chains corpus generation and the shim check itself.
# The official CM conformance suite, Deno lane.
conformance:
    cd harness && deno task conformance

# Scheduler-order sensitivity (docs/architecture.md §6) — spec-allowed
# nondeterminism; FIFO when DELTIC_SCHED_SEED is unset.
# The affected suites re-run under seeded-shuffle scheduling.
sched-seeds: shim fixtures corpus
    cd runtime && DELTIC_SCHED_SEED=1 deno task test
    cd runtime && DELTIC_SCHED_SEED=4242 deno task test
    cd harness && DELTIC_SCHED_SEED=1 deno task conformance

# Consumer conformance legs are separate (`websocket-conformance` below).
# Ports unit suites.
test-ports:
    cd ports/webcrypto && deno test --allow-read tests/
    cd ports/websocket && deno task test

# node-datachannel is a Node-API addon with linux prebuilds for both x64
# and arm64.
# webrtc unit suite.
test-webrtc:
    cd ports/webrtc && deno install --allow-scripts=npm:node-datachannel && deno test -A webrtc.test.ts

# ----- engine lanes -----------------------------------------------------------

# Pinned lanes (sm-pinned, jsc-pinned) are required gates — a deviation
# exits 1; sha256-verified fetches (tools/shell/pins.json). Nightly/trunk
# lanes (sm-nightly, jsc-trunk) are findings-only — exit 0 even with
# deviations; 2 is reserved for infrastructure failure.
# One engine-shell lane: fetch (cached), then run.
shell-lane lane *args: shim corpus
    deno run -A tools/shell/fetch.ts {{lane}}
    deno run -A tools/shell/run-lane.ts {{lane}} {{args}}

# JSC has no arm64 channel (jsc-built-products is x86_64-only), so its
# lane guards on the arch and skips cleanly elsewhere.
# The per-push pinned shell gates: sm-pinned everywhere; jsc-pinned on x64.
shells:
    just shell-lane sm-pinned
    @if [ "$(uname -m)" = "x86_64" ]; then just shell-lane jsc-pinned; else echo "jsc-pinned: skipped (no arm64 channel)"; fi

# The Deno canary probe (V8-trailing-edge d8-lane substitute; findings-only).
deno-canary *args:
    deno run -A tools/shell/deno-canary.ts {{args}}

# The repo-local cache is what run-lane.ts expects
# (PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache — cache THAT path in CI,
# not ~/.cache/ms-playwright). CI passes --with-deps for system
# libraries; locally a plain `just browsers-install` usually suffices.
# One-time browser provisioning (chromium + firefox) into .browser-cache/.
browsers-install *flags:
    PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache deno run -A npm:playwright@1.62.1 install {{flags}} chromium firefox

# WebKit stays non-blocking until it has a track record (issue #11): the
# lane's expectation overlay encodes JSC's missing multi-memory, and GH's
# ubuntu-24.04 matches the ABI playwright's WebKit wants (no library
# staging expected).
browsers-install-webkit *flags:
    PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache deno run -A npm:playwright@1.62.1 install {{flags}} webkit

# chromium and firefox are required (chromium expects exact Deno-lane
# parity; the firefox driver sets the JSPI pref itself — shipped-channel
# config, unlike the jsshell); webkit is best-effort per
# docs/architecture.md §3/§12 (issue #11).
# One browser lane (chromium / firefox / webkit).
browser-lane lane *args: shim corpus
    deno run -A tools/browser/run-lane.ts {{lane}} {{args}}

# The post-merge browser gates.
browsers:
    just browser-lane chromium
    just browser-lane firefox

# ----- consumer smokes + exams (polymorph checkouts; docs/consumers.md) -------

# Translate all eight targets, then execute the suites.
# polymorph-tls conformance under deltic (issue #18). --allow-env: run.ts
# imports smoke-c0's common.ts, whose POLYMORPH_ROOT/WOSH_ROOT env reads
# (fab5c2e) predate this recipe's permission list.
smoke-tls: shim
    deno run --allow-read --allow-env=POLYMORPH_ROOT,WOSH_ROOT tools/smoke-tls/run.ts --exec

# The C0 smoke legs (tools/smoke-c0/REPORT.md).
smoke-c0: shim
    cd tools/smoke-c0 && deno task leg1 && deno task leg2 && deno task leg3 && deno task leg4

# Spawns their echod; DENO_CERT rides the task definition.
# The consumer's REAL websocket conformance suite under this host.
websocket-conformance: shim
    cd ports/websocket && deno task conformance

# The host-boundary microbench (bench/boundary/README.md): calls/sec per
# ABI shape for the CURRENT tree, on plain node (callback + jspi) and
# deno. Manual instrument, not a gate — numbers are box-relative; the
# committed README carries the baseline and the issues it feeds (#8,
# #54; #17's record). `just bench-boundary with-jco` adds the incumbent
# jco lane (npm tree + transpile, prepared on first use).
bench-boundary *jco: shim
    #!/usr/bin/env bash
    set -euo pipefail
    (cd bench/boundary/guest && cargo build --release --target wasm32-wasip2)
    deno run -A tools/release-bundle/build.ts --out bench/boundary/deltic-embedder.local.mjs
    if [ "{{jco}}" = "with-jco" ]; then
        cd bench/boundary
        [ -d node_modules ] || npm ci --no-audit --no-fund
        node jco-transpile.mjs transpile guest/target/wasm32-wasip2/release/boundary_bench_guest.wasm \
            --name bench -I async -o generated
        cd ../..
        node bench/boundary/sweep.mjs deltic-embedder.local.mjs \
            ../../target/wasm32-unknown-unknown/release/translator_shim.wasm --with-jco
    else
        node bench/boundary/sweep.mjs deltic-embedder.local.mjs \
            ../../target/wasm32-unknown-unknown/release/translator_shim.wasm
    fi


# ----- release ----------------------------------------------------------------

# The standard shim (what every suite runs against), the size-tuned
# variant (flags per crates/translator-shim/README.md — reproduces the
# published size figures without editing the workspace manifest), the
# embedder bundle, and SHA256SUMS — all written to the repo root. NOTE:
# the size-tuned build leaves the MIN shim in target/; rerun `just shim`
# before running test suites locally afterwards.
# The release artifacts, exactly as the release workflow publishes them.
# Since the shim recipe adopted the size tuning (#58), the tuned build IS
# the artifact every suite runs against, and the former separate "min"
# variant is redundant — one shim, tested and shipped identically.
release-artifacts: shim
    cp target/wasm32-unknown-unknown/release/translator_shim.wasm deltic-translator-shim.wasm
    deno run -A tools/release-bundle/build.ts --out deltic-embedder.mjs
    sha256sum deltic-translator-shim.wasm deltic-embedder.mjs > SHA256SUMS
