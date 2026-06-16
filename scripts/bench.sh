#!/bin/bash
# bench.sh, Demiurge unified bench launcher (T5 v0.1)
#
# One entry point for all bench runs. Replaces 20+ scattered run-*.sh scripts.
# Dispatches to the right benchmark-*.ts with consistent options, pre-bench
# gate, run manifest emission, and output location.
#
# Usage:
#   scripts/bench.sh <bench> [--mode iteration|publish] [--smoke|--mini|--full]
#                            [--max-rules N] [--cold-ok] [--resume <file>]
#                            [--judge-model M] [--answer-model M] [--dry-run]
#
# Examples:
#   scripts/bench.sh lme                   # default: --mini, iteration
#   scripts/bench.sh locomo --mini         # explicit mini
#   scripts/bench.sh beam --full           # full BEAM 100K (~3h)
#   scripts/bench.sh lme --mode publish    # publish (routing on, real numbers)
#   scripts/bench.sh lme --dry-run         # show what would run, do nothing
#
# Modes:
#   iteration (default), ANSWER_ROUTING=false, no --routed flag, fast/cheap signal
#   publish            , uniform engine config matching production, --routed
#
# Sizes:
#   --smoke = 10Q sanity. Catches broken pipelines. Don't quote scores from smokes.
#   --mini  = bench-defined minimum set. Iteration default.
#   --full  = bench's largest tier. Publish-time only.
#
# Outputs:
#   Result JSON at /root/demiurge/benchmark-results/<bench>-<size>-<commit>-<ts>.json
#   Run log at /root/demiurge/scripts/logs/<bench>-<size>-<ts>.log
#
# Place at /root/demiurge/scripts/bench.sh

set -e
cd "$(dirname "$0")/.."  # /root/demiurge

# --- Defaults ---
BENCH=""
MODE="iteration"
SIZE="mini"
MAX_RULES=65
JUDGE_MODEL="gpt-4o-mini"
ANSWER_MODEL=""  # set per-mode below
COLD_OK=0
RESUME=""
DRY=0

# --- Parse args ---
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)         MODE="$2"; shift 2 ;;
    --smoke)        SIZE="smoke"; shift ;;
    --mini)         SIZE="mini"; shift ;;
    --full)         SIZE="full"; shift ;;
    --max-rules)    MAX_RULES="$2"; shift 2 ;;
    --judge-model)  JUDGE_MODEL="$2"; shift 2 ;;
    --answer-model) ANSWER_MODEL="$2"; shift 2 ;;
    --cold-ok)      COLD_OK=1; shift ;;
    --resume)       RESUME="$2"; shift 2 ;;
    --dry-run)      DRY=1; shift ;;
    -h|--help)
      head -25 "$0" | tail -22
      exit 0
      ;;
    *)
      if [ -z "$BENCH" ]; then
        BENCH="$1"
      else
        echo "Unknown arg: $1 (BENCH already set to $BENCH)"
        exit 2
      fi
      shift
      ;;
  esac
done

[ -z "$BENCH" ] && { echo "Usage: $0 <bench> [opts]   (run $0 --help)"; exit 2; }

# --- Validate ---
case "$BENCH" in
  lme|locomo|beam) ;;
  *) echo "Unsupported bench: $BENCH (v0.1 supports: lme, locomo, beam)"; exit 2 ;;
esac

case "$MODE" in
  iteration|publish) ;;
  *) echo "Unsupported mode: $MODE (use iteration or publish)"; exit 2 ;;
esac

case "$SIZE" in
  smoke|mini|full) ;;
esac

# --- Resolve runner + size flag ---
case "$BENCH" in
  lme)
    SCRIPT="scripts/benchmark-longmemeval.ts"
    case "$SIZE" in
      smoke) SIZE_FLAG="--max-questions 10" ;;
      mini)  SIZE_FLAG="--mini --seed-assistant" ;;
      full)  SIZE_FLAG="--full --seed-assistant" ;;
    esac
    ;;
  locomo)
    SCRIPT="scripts/benchmark-locomo-official.ts"
    case "$SIZE" in
      smoke) SIZE_FLAG="--max-questions 10" ;;
      mini)  SIZE_FLAG="--mini" ;;
      full)  SIZE_FLAG="" ;;
    esac
    ;;
  beam)
    SCRIPT="scripts/benchmark-beam.ts"
    case "$SIZE" in
      smoke) SIZE_FLAG="--max-questions 10 --size 100K" ;;
      mini)  SIZE_FLAG="--mini --size 100K" ;;
      full)  SIZE_FLAG="--size 100K" ;;
    esac
    ;;
esac

# --- Mode-specific env ---
case "$MODE" in
  iteration)
    # Unrouted, lighter answer model unless overridden.
    export ANSWER_ROUTING=false
    [ -z "$ANSWER_MODEL" ] && ANSWER_MODEL="gpt-4.1-mini"
    ROUTED_FLAG=""
    ;;
  publish)
    # Production config: routed, real engine.
    export ANSWER_ROUTING=true
    [ -z "$ANSWER_MODEL" ] && ANSWER_MODEL="gpt-4.1-mini"
    ROUTED_FLAG="--routed"
    ;;
esac

# CAX21 has NODE_ENV=production globally - production refuses TEST_MODE
unset NODE_ENV
export NODE_ENV=development
export BENCH_MODE=true
export TEST_MODE=true  # A2 back-compat alias
export TIMELINE_ALWAYS=true
export AUTH_TOKEN=benchmark-beam-demiurge-ab-tests-2026
[ "$COLD_OK" = "1" ] && export BENCH_COLD_OK=1

# --- Build command ---
CMD="node_modules/.bin/tsx $SCRIPT $SIZE_FLAG --judge-model $JUDGE_MODEL --max-rules $MAX_RULES $ROUTED_FLAG"
[ -n "$RESUME" ] && CMD="$CMD --resume $RESUME"

# --- Output paths ---
COMMIT=$(git log -1 --format='%h')
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG_DIR=scripts/logs
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${BENCH}-${SIZE}-${TS}.log"

# --- Summary ---
echo "=========================================="
echo "  DEMIURGE BENCH LAUNCHER  $TS"
echo "=========================================="
echo "  Bench:        $BENCH"
echo "  Size:         $SIZE"
echo "  Mode:         $MODE"
echo "  Commit:       $COMMIT"
echo "  Max rules:    $MAX_RULES"
echo "  Judge model:  $JUDGE_MODEL"
echo "  Answer model: $ANSWER_MODEL"
echo "  Routing:      ${ANSWER_ROUTING}"
echo "  Cold OK:      $COLD_OK"
echo "  Log:          $LOG_FILE"
echo "  Command:"
echo "    $CMD"
echo "=========================================="

if [ "$DRY" = "1" ]; then
  echo ""
  echo "DRY RUN, exiting before execution"
  exit 0
fi

# --- Pre-bench gate ---
if [ -x scripts/pre-bench-gate.sh ]; then
  echo ""
  echo "## pre-bench gate"
  bash scripts/pre-bench-gate.sh --info-only --bench "$BENCH" --launcher "$0" 2>&1 | tail -10
  echo ""
fi

# --- Execute ---
echo "## launching bench"
echo "Output streaming to $LOG_FILE"
echo ""
T0=$(date +%s)
$CMD 2>&1 | tee "$LOG_FILE"
T1=$(date +%s)
WALL=$((T1 - T0))

echo ""
echo "=========================================="
echo "  COMPLETE  wall=${WALL}s"
echo "  Log: $LOG_FILE"
RESULT_JSON=$(ls -t benchmark-results/${BENCH}*${COMMIT}*.json 2>/dev/null | head -1)
[ -n "$RESULT_JSON" ] && echo "  Result: $RESULT_JSON"
SCORE=$(grep -E "J-Score|accuracy" "$LOG_FILE" | tail -1)
echo "  Score: $SCORE"
echo "=========================================="
