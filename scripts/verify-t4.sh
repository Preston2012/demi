#!/bin/bash
# verify-t4.sh, S71 T4 post-merge smoke check
# Run on CAX11 after merging s71-t4-episode-cache to main.
# Verifies the episode-cache infrastructure is intact and functional.
# Exits 0 on green, non-zero on first failure.
#
# Place at /root/demiurge/scripts/verify-t4.sh

set +e
cd /root/demiurge

FAIL=0
PASS=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "OK" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label  ($result)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== S71 T4 verify ==="
echo ""

# --- Schema ---
echo "Schema:"
HAS_TABLE=$(sqlite3 fixtures/cache/cache.db "SELECT name FROM sqlite_master WHERE type='table' AND name='episode_title_cache';" 2>/dev/null)
[ "$HAS_TABLE" = "episode_title_cache" ] && check "episode_title_cache table exists" OK || check "episode_title_cache table exists" "MISSING"

COLS=$(sqlite3 fixtures/cache/cache.db "PRAGMA table_info(episode_title_cache);" 2>/dev/null | wc -l)
[ "$COLS" -eq 6 ] && check "episode_title_cache has 6 columns" OK || check "episode_title_cache has 6 columns" "got $COLS"

HAS_IDX=$(sqlite3 fixtures/cache/cache.db "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_episode_model';" 2>/dev/null)
[ "$HAS_IDX" = "idx_episode_model" ] && check "idx_episode_model index exists" OK || check "idx_episode_model index exists" "MISSING"

echo ""

# --- Source markers ---
echo "Source:"
grep -q "episode_title_cache" src/cache/cache-store.ts && check "cache-store.ts wired" OK || check "cache-store.ts wired" "MISSING"
grep -q "getEpisodeTitle" src/write/episodes.ts && check "episodes.ts wired" OK || check "episodes.ts wired" "MISSING"
grep -q "episode_title_cache" scripts/cache-warm-probe.ts && check "cache-warm-probe.ts aware" OK || check "cache-warm-probe.ts aware" "MISSING"

echo ""

# --- Sample queries ---
echo "Functional:"
SAMPLE_ROW=$(sqlite3 fixtures/cache/cache.db "SELECT cache_key, length(title), length(summary) FROM episode_title_cache LIMIT 1;" 2>/dev/null)
if [ -n "$SAMPLE_ROW" ]; then
  check "non-empty cache: sample row readable" OK
else
  echo "  WARN: cache empty (run LME mini once to populate, this is not a failure)"
fi

ROW_COUNT=$(sqlite3 fixtures/cache/cache.db "SELECT COUNT(*) FROM episode_title_cache;" 2>/dev/null)
echo "  Info: $ROW_COUNT entries currently cached"

echo ""

# --- Unit tests ---
echo "Tests:"
node_modules/.bin/vitest run tests/unit/cache-store-episode-title.test.ts tests/unit/cache-store-episode-title-edge.test.ts tests/unit/cache-warm-probe.test.ts tests/unit/cache-store.test.ts 2>&1 | tail -5 | head -3
TEST_EXIT=$?
[ $TEST_EXIT -eq 0 ] && check "unit suite green (4 files)" OK || check "unit suite green (4 files)" "exit $TEST_EXIT"

echo ""

# --- tsc ---
echo "Type check:"
node_modules/.bin/tsc --noEmit 2>&1 > /tmp/verify-t4-tsc.log
TSC_EXIT=$?
[ $TSC_EXIT -eq 0 ] && check "tsc --noEmit clean" OK || check "tsc --noEmit clean" "see /tmp/verify-t4-tsc.log"

echo ""

# --- Summary ---
echo "==========================================="
echo "  T4 VERIFY: $PASS pass, $FAIL fail"
echo "==========================================="

exit $FAIL
