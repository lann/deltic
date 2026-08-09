#!/usr/bin/env sh
# Reproduces the CM-4 filing evidence from the pristine submodule copies.
# See root-cause.md for the full analysis. The reference harness HANGS after
# any failing assertion (non-daemon threads) — every failing leg runs under
# `timeout` and is judged by its traceback text, not its exit code.
set -eu
cd "$(dirname "$0")/../.."
SRC=third_party/component-model/design/mvp/canonical-abi
ART=exams/wasmtime-exclusivity
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/design/mvp/canonical-abi"
cp "$SRC/definitions.py" "$SRC/run_tests.py" "$WORK/design/mvp/canonical-abi/"

echo "== leg 0: stock suite sanity (pristine)"
( cd "$WORK/design/mvp/canonical-abi" && timeout 180 python3 run_tests.py | tail -1 | grep -qx "All tests passed" )
echo "   ok: All tests passed"

echo "== leg 1: new test vs pristine definitions.py -> must fail at the gating assertion"
( cd "$WORK" && patch -p1 -s < "$OLDPWD/$ART/cm4-run-tests.patch" )
set +e
( cd "$WORK/design/mvp/canonical-abi" && timeout 120 python3 run_tests.py > "$WORK/leg1.out" 2>&1 )
set -e
grep -q "assert(poke_state == Subtask.State.RETURNED)" "$WORK/leg1.out"
echo "   ok: failed at the sync-streams expectation (STARTING observed; traceback in leg1.out)"

echo "== leg 2: new test with the resolution-scoped fix -> passes; the one conflicting stock test skipped"
( cd "$WORK" && patch -p1 -s < "$OLDPWD/$ART/cm4-reference-fix.patch" )
python3 - "$WORK/design/mvp/canonical-abi/run_tests.py" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
call = "\ntest_callback_interleaving()\n"
assert s.count(call) == 1
open(p, "w").write(s.replace(call,
  "\n# test_callback_interleaving()  # encodes the hold-semantics; see root-cause.md\n", 1))
PYEOF
( cd "$WORK/design/mvp/canonical-abi" && timeout 180 python3 run_tests.py | tail -1 | grep -qx "All tests passed" )
echo "   ok: All tests passed (incl. test_resolved_task_gates_entry)"

echo "== leg 3: the fix vs the FULL stock suite -> test_callback_interleaving's NONE window fails"
python3 - "$WORK/design/mvp/canonical-abi/run_tests.py" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
open(p, "w").write(s.replace(
  "\n# test_callback_interleaving()  # encodes the hold-semantics; see root-cause.md\n",
  "\ntest_callback_interleaving()\n", 1))
PYEOF
set +e
( cd "$WORK/design/mvp/canonical-abi" && timeout 120 python3 run_tests.py > "$WORK/leg3.out" 2>&1 )
set -e
grep -q "assert(ret == EventCode.NONE)" "$WORK/leg3.out"
echo "   ok: the progress-free poll window observed the admitted producer (traceback in leg3.out)"

echo "ALL LEGS OK"
