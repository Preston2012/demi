#!/bin/bash
# bench-import-check.sh - verify all bench launchers can resolve their imports
# Run after any multi-file patch BEFORE firing benches.
# Catches the S65 mistake: callJudgeCached call sites added but import only landed in one file.

set +e
cd "${1:-/root/demiurge}" || exit 1

FAIL=0

# For every bench launcher: extract every imported symbol from call sites that look like a function,
# then confirm there's a matching import line.
for f in scripts/benchmark-*.ts src/benchmark/public/*/runner.ts; do
  [ -f "$f" ] || continue
  # Get symbols called via SYMBOL( - filter to ones that look bench-cache-related
  for sym in callJudgeCached callLLM resolveAdapter; do
    if grep -q "\b${sym}(" "$f"; then
      if ! grep -qE "import.*\b${sym}\b" "$f"; then
        echo "❌ $f calls ${sym} but no import found"
        FAIL=1
      fi
    fi
  done
done

# tsc no-emit on the whole repo: catches missing imports anywhere else
if [ -x ./node_modules/.bin/tsc ]; then
  ./node_modules/.bin/tsc --noEmit 2>&1 | grep -E "error TS" | head -10
  if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo "❌ tsc found errors"
    FAIL=1
  fi
fi

if [ $FAIL -eq 0 ]; then
  echo "✓ all bench launchers compile + imports resolve"
fi
exit $FAIL
