#!/usr/bin/env sh
# Determinism check for wasmtime on the CM-4 arbiter (see RESULTS.md).
# Requires a `wasmtime` new enough to parse the post-#655 suite syntax
# (a 2026-08+ dev release works; the 47.0.1 release CLI does not).
set -eu
cd "$(dirname "$0")/../.."
WAST=third_party/component-model/test/async/sync-streams.wast
WASMTIME="${WASMTIME:-wasmtime}"
"$WASMTIME" --version
N="${N:-50}"
i=1
while [ "$i" -le "$N" ]; do
  "$WASMTIME" wast -W component-model-async=y -W component-model-more-async-builtins=y "$WAST"
  i=$((i + 1))
done
echo "$N/$N passes: deterministic"
