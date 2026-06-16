#!/bin/bash
# C3: MAB sh_6k re-bench post-cheat-removal.
# Per CI: MAB sh_6k mini = full = 100Q. Just run mini.
# Per STATE.md: Expected ~40% post-cheat (was 51% pre-cheat, 98% with cheat).
#
# Iteration mode (unrouted) per CI #2096.

set -euo pipefail
cd /root/demiurge

# CAX21 NODE_ENV trap defense
unset NODE_ENV
export NODE_ENV=development

export DEMIURGE_API_KEY="benchmark-$(printf 'a%.0s' {1..24})"
export BENCH_MODE=true
export TEST_MODE=true  # A2 back-compat alias
export BENCH_SKIP_CIRCUIT_BREAKER=true
export DB_PATH=:memory:
export LOG_LEVEL=warn
export ANSWER_ROUTING=false     # iteration mode

# Pre-bench gate
bash /root/demiurge/scripts/pre-bench-gate.sh --info-only --bench mab \
  --launcher /root/demiurge/scripts/c3-mab-rebench.sh || {
  echo "pre-bench-gate failed - aborting"
  exit 1
}

TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG=/tmp/c3-mab-mini-${TS}.log
echo "Starting C3 MAB sh_6k mini at $(date -u +%FT%TZ)" | tee "$LOG"
echo "Commit: $(git rev-parse HEAD)" | tee -a "$LOG"
echo "Config: unrouted iteration mode, BENCH_SKIP_DEDUP=false" | tee -a "$LOG"
echo "" | tee -a "$LOG"

./node_modules/.bin/tsx src/benchmark/public/memory-agent-bench/runner.ts \
  --mini --judge-model gpt-4o-mini --max-rules 65 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "C3 MAB mini complete at $(date -u +%FT%TZ)" | tee -a "$LOG"
echo "Log: $LOG"
