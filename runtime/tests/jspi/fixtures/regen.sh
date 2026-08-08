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
  wasm-tools validate "$wasm"
done

echo "==== done"
