#!/bin/bash
# Pre-benchmark golden config verification V3 (R29 WC-3).
#
# Checks code state against the golden behavior contract (golden-config.json).
# Run BEFORE every benchmark and in CI. Red is NON-WAIVABLE in CI.
#
# V3 changes vs V2:
#  - dropped dead checks: BRUTE_FORCE, RAR, STONE_INGEST/STONE_ENABLED, and the
#    extracted-facts presence check (those pins were removed in golden v5 / WC-2).
#  - the prompt/classifier surface is now pinned by sha256 checksum
#    (golden-config.json prompts.fileHashes, ruled Option C); a mismatch is RED.
#  - missing referenced files print a FAIL line instead of aborting mid-script
#    (no `set -e`); all checks run and the script reports every failure.
#  - the HYBRID line reports the real config default instead of an always-OK echo.
#  - a waive (GOLDEN_WAIVE="reason") is refused under CI and, when allowed
#    locally, writes a stamp to scripts/.golden-waivers.log and prints the
#    CHEAT_LOG line the operator must add.

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

FAIL=0
warn() { echo "FAIL: $1"; FAIL=1; }
ok() { echo "  OK: $1"; }

echo '=== GOLDEN CONFIG VERIFICATION V3 ==='
echo ''

# --- CLASSIFIER CHECKS ---
if grep -q 'january\|february' src/retrieval/query-classifier.ts; then
  ok 'Classifier: temporal matches month names'
else
  warn 'Classifier: temporal does NOT match month names (regression)'
fi

if grep -q 'isWhenQuestion' src/retrieval/query-classifier.ts; then
  warn 'Classifier: contains isWhenQuestion (narrowed temporal)'
else
  ok 'Classifier: no temporal narrowing'
fi

COVERAGE_LINES=$(grep -c 'return.*coverage' src/retrieval/query-classifier.ts)
if [ "$COVERAGE_LINES" -gt 3 ]; then
  warn "Classifier: $COVERAGE_LINES coverage return paths (original has 1)"
else
  ok "Classifier: $COVERAGE_LINES coverage return paths"
fi

# --- PROMPT CHECKS ---
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

# --- PROMPT/CLASSIFIER CHECKSUM PIN (Option C, golden prompts.fileHashes) ---
# Recompute sha256 of each pinned file and compare to golden-config.json. A
# mismatch means the prompt/classifier/scorer surface changed without a golden
# update + re-measurement. RED.
while IFS=$'\t' read -r path expected; do
  [ -z "$path" ] && continue
  if [ ! -f "$path" ]; then
    warn "fileHash: pinned file missing: $path"
    continue
  fi
  actual=$(sha256sum "$path" | cut -d' ' -f1)
  if [ "$actual" = "$expected" ]; then
    ok "fileHash: $path matches pin"
  else
    warn "fileHash: $path changed (pin $expected, got $actual). Update golden-config.json prompts.fileHashes + re-measure."
  fi
done < <(python3 -c "
import json
g=json.load(open('golden-config.json'))
fh=g.get('prompts',{}).get('fileHashes',{})
for k,v in fh.items():
    if k.startswith('_'): continue
    print(f'{k}\t{v}')
")

# --- LOCOMO SCRIPT (prompt honesty) ---
if grep -q 'answerPrompt:' scripts/benchmark-locomo-official.ts; then
  warn 'LOCOMO: passes answerPrompt override (defeats prompt honesty)'
else
  ok 'LOCOMO: prompt selection is engine-side (S65 prompt-honesty)'
fi

# --- DEDUP THRESHOLD ---
if [ ! -f src/write/dedup.ts ]; then
  warn 'dedup.ts missing'
else
  THRESH=$(grep 'DEFAULT_SIMILARITY_THRESHOLD' src/write/dedup.ts | grep -oP '[0-9]+\.[0-9]+')
  if [ "$THRESH" != "0.95" ]; then
    warn "Write dedup threshold $THRESH (expected 0.95)"
  else
    ok 'Write dedup threshold 0.95'
  fi
fi

# --- FLAG PATTERN HYGIENE ---
# flag-defaults.ts is the sanctioned strict-boolean parser (WC-1): it is the
# one place allowed to compare a string to 'false'. The check targets ad-hoc
# flag reads elsewhere, so exclude the parser itself.
BAD_FLAGS=$(grep -rn "=== 'false'" src/ --include='*.ts' 2>/dev/null | grep -v node_modules | grep -v test | grep -v 'src/benchmark/' | grep -v 'src/config/flag-defaults.ts' | grep -vE ':[0-9]+:[[:space:]]*(//|\*)' | head -1)
if [ -n "$BAD_FLAGS" ]; then
  warn "Found === 'false' flag pattern: $BAD_FLAGS"
else
  ok 'All flags use !== true'
fi

# --- HYBRID FUSION DEFAULT (report the real config default, not an echo) ---
if grep -qE 'lexicalWeight:.*default\(0\.3\)' src/config.ts; then
  ok 'lexicalWeight default 0.3 (Packet A revert)'
else
  warn 'lexicalWeight default not 0.3 (Packet A regression)'
fi

echo ''
if [ $FAIL -eq 0 ]; then
  echo '=== ALL CHECKS PASSED. Safe to benchmark. ==='
  exit 0
fi

echo '=== VERIFICATION FAILED. ==='

# --- WAIVE GATE ---
# Red is non-waivable in CI. Locally, a waive needs a reason and is stamped.
if [ -n "${CI:-}" ]; then
  echo 'CI run: red is non-waivable. Fix the golden contract before merging.'
  exit 1
fi

if [ -n "${GOLDEN_WAIVE:-}" ]; then
  STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ) waive: ${GOLDEN_WAIVE} (commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown))"
  echo "$STAMP" >> scripts/.golden-waivers.log
  echo "WAIVED locally and stamped to scripts/.golden-waivers.log:"
  echo "  $STAMP"
  echo "You MUST also add a CHEAT_LOG entry, e.g.:"
  echo "  - $(date -u +%Y-%m-%d) golden-config verify waived: ${GOLDEN_WAIVE}"
  exit 0
fi

echo 'To waive locally (NOT in CI): set GOLDEN_WAIVE="reason" and re-run.'
exit 1
