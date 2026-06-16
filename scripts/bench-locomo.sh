#!/bin/bash
# LOCOMO bench launcher.
#
# S67 LOCKDOWN (2026-05-09): ONE PATH.
#
# The legacy seedConversationFacts seeder was deleted after it caused a -34pp
# catastrophic regression (54.4% -> 20.3%) on 2026-05-09 22:08 UTC. The legacy
# seeder wrote with no user_id (system partition), the runner read with
# userId=locomo-conv-{ci}. Partition mismatch -> 0 retrieval -> hallucinated
# answers. The flag-controlled fork (--ingest-mode opt-in) silently fell into
# the broken path whenever the launcher invocation pattern dropped the flag.
#
# Now: dispatch.ingest() is the only seed path. No --ingest-mode flag. No
# --facts-file (hard-errors). The runner's sanity probe aborts the bench if
# seed produces zero retrievable memories on a fresh user partition. There is
# no way to silently produce a wrong score.
#
# Per S59A:
#   - LOCOMO defaults to UNROUTED iteration mode (#2015). Pass --routed for
#     publish-time runs (Grok routing on, ~16min wall, ~$3 bill).
#   - Defaults to --mini (296Q stratified). Pass --full for 1540Q.
#   - --rerank turns on TEMPR. --gating adds query-type rerank gating.
#
# Usage:
#   bash scripts/bench-locomo.sh                       # mini, unrouted, ingest
#   bash scripts/bench-locomo.sh --rerank --gating     # mini + TEMPR
#   bash scripts/bench-locomo.sh --routed --full       # full + routed (publish)

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

# CAX21 NODE_ENV trap defense (per TOOLBOOK)
unset NODE_ENV
export NODE_ENV=development

# S64: --mini is the canonical 296Q stratified sample (20% of 1540Q full).
# Matches the category distribution of full LOCOMO; the right iteration default.
LIMIT_QA="--mini"
RERANK=0
GATING=0
PASSTHROUGH=()

while [ $# -gt 0 ]; do
  case "$1" in
    --full)     LIMIT_QA=""; shift ;;
    --mini)     LIMIT_QA="--mini"; shift ;;
    --rerank)   RERANK=1; shift ;;
    --gating)   GATING=1; shift ;;
    --routed)   PASSTHROUGH+=("$1"); shift ;;
    --no-route) PASSTHROUGH+=("$1"); shift ;;
    --ingest-mode)
      echo "NOTE: --ingest-mode is now the default and only mode (S67 lockdown). Flag ignored." >&2
      shift ;;
    --limit-qa)
      echo "ERROR: --limit-qa is no longer supported. Use --mini (296Q stratified)" >&2
      echo "       or --full (1540Q). limit-qa N samples first-N-per-conv which" >&2
      echo "       has a different category distribution than --mini and produces" >&2
      echo "       scores that are NOT comparable to historical baselines (#2071)." >&2
      exit 1 ;;
    --facts-file)
      echo "ERROR: --facts-file is no longer supported (S67 lockdown). The legacy" >&2
      echo "       pre-extracted-facts seeder was removed after it caused a -34pp" >&2
      echo "       silent regression by writing to the wrong user partition." >&2
      echo "       The bench now uses dispatch.ingest() exclusively." >&2
      exit 1 ;;
    *)          PASSTHROUGH+=("$1"); shift ;;
  esac
done

# Reranker config, read in src/retrieval/reranker.ts at retrieval time.
# ensureBenchEnv() does NOT manage these because they are TEMPR tuning knobs.
if [ $RERANK -eq 1 ]; then
  export RERANKER_ENABLED=true
  if [ $GATING -eq 1 ]; then
    export RERANK_QUERY_TYPE_GATING=true
  else
    export RERANK_QUERY_TYPE_GATING=false
  fi
fi

# Pre-bench gate (info-only on this launcher; does not block)
echo "=== Pre-bench gate ==="
bash scripts/pre-bench-gate.sh --info-only --bench locomo-official --launcher "$0"
echo

echo "=== Launching LOCOMO ==="
echo "  Mode: dispatch.ingest() (S67 lockdown, only path)"
echo "  RERANKER_ENABLED=${RERANKER_ENABLED:-unset}"
echo "  RERANK_QUERY_TYPE_GATING=${RERANK_QUERY_TYPE_GATING:-unset}"
echo "  RERANK_RECENCY_ALPHA_TEMPORAL=${RERANK_RECENCY_ALPHA_TEMPORAL:-unset}"
echo "  Args: $LIMIT_QA ${PASSTHROUGH[*]:-}"
echo "  Started: $(date -u +%FT%TZ)"
echo

# All env hygiene (TEST_MODE, ANSWER_ROUTING default, STONE_*, etc.) happens
# inside the .ts runner via ensureBenchEnv('locomo'). Do NOT export those here.

# S68: cache-warm probe (brain #2184). Logs WARM/COLD/PARTIAL banner.
# Aborts on COLD unless BENCH_COLD_OK=1 (bypass for intentional cold runs).
npx tsx scripts/cache-warm-probe.ts locomo 2>&1 | tee -a "$LOG"

/root/demiurge/node_modules/.bin/tsx scripts/benchmark-locomo-official.ts $LIMIT_QA "${PASSTHROUGH[@]}"

EXIT=$?
echo
echo "Finished: $(date -u +%FT%TZ) (exit $EXIT)"
exit $EXIT
