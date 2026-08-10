#!/usr/bin/env bash
# Regenerates the compiled .wasm fixtures in runtime/tests/jspi/fixtures/
# from their .wat sources. Run this after editing any .wat file here.
#
# Requires: wasm-tools CLI (validated against 1.247.0) on PATH.
set -euo pipefail
cd "$(dirname "$0")"

for wat in *.wat; do
  wasm="${wat%.wat}.wasm"
  echo "==== $wat -> $wasm"
  wasm-tools parse "$wat" -o "$wasm"
  # `cm-async` is needed by fact-callback-suspend.wat (async lifts/lowers).
  # Note the authority on validity is the translator itself (wasmparser 0.252
  # via wasmtime-environ), not this CLI -- see
  # crates/translator-shim/testdata/gen.sh for the same caveat.
  wasm-tools validate --features component-model,cm-async "$wasm"
done

echo "==== done"
