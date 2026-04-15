#!/bin/bash
# Pre-benchmark golden config verification V2.
# Checks code state against GOLDEN_STATE.md markers.
# Run BEFORE every benchmark. Abort on mismatch.
set -e
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

FAIL=0
warn() { echo "FAIL: $1"; FAIL=1; }
ok() { echo "  OK: $1"; }

echo '=== GOLDEN CONFIG VERIFICATION V2 ==='
echo ''

# --- CLASSIFIER CHECKS ---
if grep -q 'january\|february' src/retrieval/query-classifier.ts; then
  ok 'Classifier: temporal matches month names (63.9% state)'
else
  warn 'Classifier: temporal does NOT match month names (V2 regression)'
fi

if grep -q 'isWhenQuestion' src/retrieval/query-classifier.ts; then
  warn 'Classifier: contains isWhenQuestion (V2 narrowed temporal)'
else
  ok 'Classifier: no V2 temporal narrowing'
fi

# Coverage: check for widened patterns that steal from single-hop
COVERAGE_LINES=$(grep -c 'return.*coverage' src/retrieval/query-classifier.ts)
if [ "$COVERAGE_LINES" -gt 3 ]; then
  warn "Classifier: $COVERAGE_LINES coverage return paths (original has 1)"
else
  ok "Classifier: $COVERAGE_LINES coverage return paths"
fi

# --- PROMPT CHECKS ---
# Only check CATEGORY_PROMPTS object literal, not getPromptForQuery function
if python3 -c "
t=open('src/inject/prompts.ts').read()
block=t[t.index('CATEGORY_PROMPTS'):t.index('};',t.index('CATEGORY_PROMPTS'))]
bad=any(w in block.lower() for w in ['enumerate','every relevant','numbered list'])
exit(0 if bad else 1)
"; then
  warn 'Prompts: enumeration language in CATEGORY_PROMPTS (V5 leak)'
else
  ok 'Prompts: no enumeration (V4)'
fi

if grep -q 'event pairs\|Event 1.*Event 2' src/inject/prompts.ts; then
  warn 'Prompts: event pair format detected (V5 leak)'
else
  ok 'Prompts: no event pairs (V4)'
fi

# --- LOCOMO SCRIPT ---
LOCOMO_LINE=$(grep 'const basePrompt' scripts/benchmark-locomo-official.ts)
if echo "$LOCOMO_LINE" | grep -q 'getPromptForQuery'; then
  warn "LOCOMO: uses getPromptForQuery (should be CATEGORY_PROMPTS)"
else
  ok 'LOCOMO: uses CATEGORY_PROMPTS'
fi

# --- ENV / FLAGS ---
if grep -q 'SQL_FIRST_ROUTING=true' .env 2>/dev/null; then
  warn 'SQL_FIRST_ROUTING=true in .env'
else
  ok 'SQL_FIRST_ROUTING off'
fi

if grep -q 'BRUTE_FORCE_ENABLED=true' .env 2>/dev/null; then
  warn 'BRUTE_FORCE=true'
else
  ok 'BRUTE_FORCE off'
fi

if grep -q 'RAR_ENABLED=true' .env 2>/dev/null; then
  warn 'RAR=true'
else
  ok 'RAR off'
fi

# --- DEDUP THRESHOLD ---
THRESH=$(grep 'DEFAULT_SIMILARITY_THRESHOLD' src/write/dedup.ts | grep -oP '[0-9]+\.[0-9]+')
if [ "$THRESH" != "0.95" ]; then
  warn "Write dedup threshold $THRESH (expected 0.95)"
else
  ok 'Write dedup threshold 0.95'
fi

# --- FACTS FILE ---
if [ ! -f fixtures/benchmark/locomo-official/extracted-facts-dual-all.json ]; then
  warn 'Dual facts file missing'
else
  ok 'Dual facts file exists'
fi

# --- FLAG PATTERN ---
BAD_FLAGS=$(grep -rn "=== 'false'" src/ --include='*.ts' 2>/dev/null | grep -v node_modules | grep -v test | head -1)
if [ -n "$BAD_FLAGS" ]; then
  warn "Found === 'false' flag pattern: $BAD_FLAGS"
else
  ok 'All flags use !== true'
fi

echo ''
if [ $FAIL -eq 0 ]; then
  echo '=== ALL CHECKS PASSED. Safe to benchmark. ==='
  exit 0
else
  echo '=== VERIFICATION FAILED. Fix before benchmarking. ==='
  exit 1
fi
