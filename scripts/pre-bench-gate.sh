#!/bin/bash
# DEMIURGE PRE-BENCH GATE
# Runs BEFORE every benchmark. Refuses exit 0 unless every check passes.
# --info-only mode: print all info but always exit 0 (for session-start sanity).
#
# Args:
#   --info-only       Skip enforcement, just print
#   --launcher PATH   Path to launcher script (will be grepped for env vars)
#   --bench NAME      Bench name (locomo, beam, lme, clonemem, dialsim, mab,
#                     frame-inject, frame-sybil, vault, frame-audit,
#                     stale-memory, attribution, paraphrase, difficulty,
#                     ece-brier, recall, custom)
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

INFO_ONLY=0
LAUNCHER=""
BENCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --info-only) INFO_ONLY=1; shift ;;
    --launcher)  LAUNCHER="$2"; shift 2 ;;
    --bench)     BENCH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

FAIL=0
warn() { echo "FAIL: $1"; FAIL=1; }
ok()   { echo "  OK: $1"; }
info() { echo "  ..: $1"; }

echo
echo '=== DEMIURGE PRE-BENCH GATE ==='
echo "Date:   $(date -u +%FT%TZ)"
echo "Host:   $(cat /etc/host-identity 2>/dev/null || echo UNKNOWN)"
echo "PWD:    $(pwd)"
echo "Branch: $(git branch --show-current)"
echo "Commit: $(git log -1 --oneline)"
echo "Origin: $(git remote get-url origin 2>/dev/null)"
echo "Bench:  ${BENCH:-unspecified}"
echo "Launcher: ${LAUNCHER:-none}"
echo

# 1. Working tree clean check
if [ -n "$(git status --porcelain)" ]; then
  warn "Working tree dirty (uncommitted changes). git status:"
  git status --short | head -10
else
  ok "Working tree clean"
fi

# 2. Branch up-to-date with origin
git fetch origin >/dev/null 2>&1
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u} 2>/dev/null || echo none)
if [ "$REMOTE" = "none" ]; then
  info "No upstream tracking branch"
elif [ "$LOCAL" = "$REMOTE" ]; then
  ok "Branch in sync with origin"
else
  warn "Branch out of sync with origin (local $LOCAL, remote $REMOTE)"
fi

# 3. Verify-golden-config
if [ -x scripts/verify-golden-config.sh ]; then
  if bash scripts/verify-golden-config.sh >/tmp/_vgc.log 2>&1; then
    ok "Golden config verified"
  else
    warn "verify-golden-config.sh FAILED:"
    tail -10 /tmp/_vgc.log
  fi
else
  warn "verify-golden-config.sh missing"
fi

# 3.5. Bench honesty doctrine (S64), CHEAT_LOG.md must exist and be referenced
# before any runner change. Surface its mtime so it's hard to ignore.
if [ -f CHEAT_LOG.md ]; then
  CHEAT_LOG_DATE=$(stat -c %y CHEAT_LOG.md 2>/dev/null | cut -d' ' -f1 || echo unknown)
  ok "CHEAT_LOG.md present (last touched $CHEAT_LOG_DATE), read before changing any runner"
else
  warn "CHEAT_LOG.md MISSING, bench honesty doctrine has been deleted. Restore from git history before running any bench."
fi

# 3.6. Bench launcher imports must resolve (S65 lesson)
# Multi-file patches can leave call sites with no matching import.
# Catches the S65 callJudgeCached mistake (call sites landed in 3 files, import in 1).
if [ -x scripts/bench-import-check.sh ]; then
  if bash scripts/bench-import-check.sh > /tmp/bench-import-check.$$.log 2>&1; then
    ok "bench launcher imports resolve"
  else
    warn "bench launcher import check FAILED:"
    cat /tmp/bench-import-check.$$.log | head -10
  fi
  rm -f /tmp/bench-import-check.$$.log
fi

# 4. NODE_ENV trap (CAX21)
if [ "${NODE_ENV:-}" = "production" ]; then
  warn "NODE_ENV=production set in shell. TEST_MODE bench writes will be REJECTED. Add 'unset NODE_ENV; export NODE_ENV=development' to launcher."
else
  ok "NODE_ENV not production (${NODE_ENV:-unset})"
fi

# 5. Bench in flight on this host
INFLIGHT=$(pgrep -af 'tsx.*benchmark|tsx.*runner' 2>/dev/null | grep -v defunct | grep -v pre-bench-gate | wc -l)
if [ "$INFLIGHT" -gt 0 ]; then
  warn "Other bench process running on this host. Per S47 W-72: never parallel-run benches on CAX11."
  pgrep -af 'tsx.*benchmark|tsx.*runner' | grep -v defunct | head -5
else
  ok "No other bench in flight on this host"
fi

# 6. Required env per bench (the bench will silently misbehave without these)
# Per S59A #2030: TEST_MODE=true was missing from LOCOMO launcher → consensus
# fired 1285 times during seed+QA → 6x wall-time inflation → bench killed at 75min.
# When you find a slow path that needs a bypass, add it here; the gate enforces
# what human memory does not.
if [ -n "$BENCH" ]; then
  REQUIRED_ENV=()
  # A2 (S71): BENCH_MODE canonical, TEST_MODE alias accepted. Required entry uses
  # alternation form 'BENCH_MODE=true|TEST_MODE=true', gate passes if either is set.
  case "$BENCH" in
    locomo*|beam*|lme*|clonemem*|mab*|dialsim*)
      REQUIRED_ENV+=("BENCH_MODE=true|TEST_MODE=true")
      ;;
    frame-*|vault*|stale-memory*|attribution*|paraphrase*|difficulty*|ece-brier*|recall*)
      REQUIRED_ENV+=("BENCH_MODE=true|TEST_MODE=true")
      ;;
  esac
  # A2 (S71): REQ may contain alternation 'KEY1=VAL|KEY2=VAL'. Gate
  # passes if ANY alternative is satisfied. Single 'KEY=VAL' form still works.
  for REQ in "${REQUIRED_ENV[@]}"; do
    ALTERNATIVES_SAT=0
    IFS='|' read -ra ALTS <<< "$REQ"
    for ALT in "${ALTS[@]}"; do
      KEY="${ALT%%=*}"
      VAL="${ALT#*=}"
      LAUNCHER_HAS=0
      SHELL_HAS=0
      if [ -n "$LAUNCHER" ] && [ -f "$LAUNCHER" ]; then
        if grep -qE "(^|[ ;])${KEY}=${VAL}([ ;\"']|$)" "$LAUNCHER"; then
          LAUNCHER_HAS=1
        fi
      fi
      SHELL_VAL="${!KEY:-}"
      if [ "$SHELL_VAL" = "$VAL" ]; then
        SHELL_HAS=1
      fi
      if [ $LAUNCHER_HAS -eq 1 ] || [ $SHELL_HAS -eq 1 ]; then
        ALTERNATIVES_SAT=1
        ok "Required env $ALT present (launcher=$LAUNCHER_HAS shell=$SHELL_HAS)"
        break
      fi
    done
    if [ $ALTERNATIVES_SAT -eq 0 ]; then
      warn "Required env $REQ MISSING for bench=$BENCH. Without it, slow paths fire and inflate wall time. Set ANY of: $REQ in launcher"
    fi
  done
fi

# 6b. Bench-env profile audit (S59A Phase 3): the strongest gate.
# Calls auditBenchEnv() via the audit script, which checks every var in
# the bench profile against current process.env. Catches launchers that
# forgot ensureBenchEnv(), runners invoked outside launchers, and any
# .env leaks the user-eyeball-grep above missed.
if [ -n "$BENCH" ] && [ -f scripts/audit-bench-env.ts ]; then
  # Map full bench-name to profile-name
  case "$BENCH" in
    locomo*) PROFILE=locomo ;;
    beam*) PROFILE=beam ;;
    lme*|longmemeval*) PROFILE=lme ;;
    clonemem*) PROFILE=clonemem ;;
    mab*) PROFILE=mab ;;
    dialsim*) PROFILE=dialsim ;;
    frame-*) PROFILE=frame ;;
    vault*) PROFILE=vault ;;
    paraphrase*) PROFILE=paraphrase ;;
    ece-brier*|ece_brier*) PROFILE=ece_brier ;;
    *) PROFILE=product ;;
  esac
  if [ -x ./node_modules/.bin/tsx ]; then
    AUDIT_OUT=$(./node_modules/.bin/tsx scripts/audit-bench-env.ts "$PROFILE" 2>&1)
    AUDIT_RC=$?
    if [ $AUDIT_RC -eq 0 ]; then
      ok "Bench-env profile '$PROFILE' clean"
    else
      warn "Bench-env audit FAILED for profile '$PROFILE'. Launcher may not be calling ensureBenchEnv(). Detail:"
      echo "$AUDIT_OUT" | sed 's/^/    /'
    fi
  else
    warn "tsx not found in node_modules/.bin, skipping bench-env audit (run npm install --include=dev)"
  fi
fi

# 6c. M10 (S65 Sprint 1): cost warning on --full runs.
# Full runs are 5-10x mini cost. Warn loudly so launcher accidents (forgetting
# to switch back to --mini after a full sweep) don't burn dollars silently.
if [ -n "$LAUNCHER" ] && [ -f "$LAUNCHER" ]; then
  IS_FULL=0
  if grep -qE '(^|[ \t])(--mode[= ]full|--full|MODE=full|SIZE=full)' "$LAUNCHER"; then
    IS_FULL=1
  fi
  # LOCOMO/LME explicit launchers without an explicit mini flag default to full.
  if grep -qE '(^|[ \t])--limit-qa[= ][0-9]+' "$LAUNCHER" && ! grep -qE '(^|[ \t])--mini' "$LAUNCHER"; then
    LIMIT=$(grep -oE -- '--limit-qa[= ][0-9]+' "$LAUNCHER" | head -1 | grep -oE '[0-9]+')
    if [ -n "$LIMIT" ] && [ "$LIMIT" -gt 100 ]; then
      IS_FULL=1
    fi
  fi
  if [ $IS_FULL -eq 1 ]; then
    echo
    echo '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    echo '!!  COST WARNING: FULL BENCH RUN DETECTED                       !!'
    echo '!!  Full LOCOMO/LME/BEAM runs are 5-10x mini cost.              !!'
    echo '!!  Confirm intent before continuing. To bypass: BENCH_FULL_OK=1 !!'
    echo '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    if [ "${BENCH_FULL_OK:-}" != "1" ] && [ $INFO_ONLY -eq 0 ]; then
      warn "Full bench run requires BENCH_FULL_OK=1 set in env. Refusing to gate-pass without explicit confirmation."
    else
      ok "Full run confirmed via BENCH_FULL_OK=1 (or info-only)"
    fi
  fi
fi

# 7. Wall-time budget reference from prior same-bench runs
if [ -n "$BENCH" ] && [ -d benchmark-results ] && [ -f scripts/budget-probe.py ]; then
  echo
  echo '--- WALL-TIME BUDGET REFERENCE ---'
  python3 scripts/budget-probe.py "$BENCH" 2>/dev/null
fi

# 8. Launcher env-var consumer check
if [ -n "$LAUNCHER" ] && [ -f "$LAUNCHER" ]; then
  echo
  echo '--- LAUNCHER ENV VAR CONSUMER CHECK ---'
  # Extract VAR=value tokens from export lines, take the VAR name
  VARS=$(grep -oE '(^|[ \t])[A-Z][A-Z0-9_]+=' "$LAUNCHER" | tr -d ' \t' | sed 's/=$//' | sort -u)
  for V in $VARS; do
    case "$V" in
      LOG|ARGS|PATH|HOME|NODE_ENV|DEMIURGE_API_KEY|DB_PATH|LOG_LEVEL|EXIT|LIMIT_QA|RERANK|GATING|REQUIRED_ENV|REQ|KEY|VAL|LAUNCHER_HAS|SHELL_HAS|SHELL_VAL|RECENT|BUDGET_INFO) continue ;;
    esac
    # Killed flags set defensively to false. verify-golden-config.sh checks them, no src/ consumer needed.
    case "$V" in
      BRUTE_FORCE_ENABLED|RAR_ENABLED) info "$V kill-sentinel (verify-golden checks)"; continue ;;
    esac
    HITS=$(grep -rl "process\.env\.$V" src/ scripts/ 2>/dev/null | head -1)
    if [ -z "$HITS" ]; then
      warn "Env var $V set in launcher but NO consumer in src/ or scripts/ (dead flag, branch mismatch?)"
    else
      info "$V consumed by: $HITS"
    fi
  done
fi

# 9. Last 3 completed runs of this bench (timing reference)
if [ -n "$BENCH" ] && [ -d benchmark-results ]; then
  echo
  echo '--- LAST 3 COMPLETED RUNS OF '$BENCH' ---'
  ls -t benchmark-results/${BENCH}*.json 2>/dev/null | head -3 | while read f; do
    python3 -c "
import json, os
try:
    d = json.load(open('$f'))
    s = d.get('summary') or {}
    c = d.get('config') or {}
    score = s.get('overallJScore') or s.get('overall') or s.get('jScore')
    score_str = f'{round(score*100,1)}pct' if isinstance(score, (int,float)) else 'unknown'
    print(f'  {os.path.basename(\"$f\")} ts={d.get(\"timestamp\",\"?\")[:19]} score={score_str} totalQ={s.get(\"totalQuestions\",\"?\")}')
except Exception as e:
    print(f'  {os.path.basename(\"$f\")} parse_error={e}')
"
  done
fi

# 9.5 Cache-warm probe (S68, brain #2184). Always info-only at the gate;
# the launcher itself enforces COLD abort (or BENCH_COLD_OK=1 bypass).
if [ -n "$BENCH" ] && [ -f scripts/cache-warm-probe.ts ] && [ -x ./node_modules/.bin/tsx ]; then
  echo
  case "$BENCH" in
    locomo*) PROBE_BENCH=locomo ;;
    beam*) PROBE_BENCH=beam ;;
    lme*|longmemeval*) PROBE_BENCH=lme ;;
    *) PROBE_BENCH="$BENCH" ;;
  esac
  ./node_modules/.bin/tsx scripts/cache-warm-probe.ts "$PROBE_BENCH" --info-only 2>&1 || \
    info "cache-warm probe failed (likely unknown bench mapping); continuing"
fi

# 10. Index file presence
if [ -f benchmark-results/index.json ]; then
  ok "Bench history index present"
else
  info "Bench history index missing (run scripts/update-bench-index.sh after a successful run)"
fi

echo
if [ $INFO_ONLY -eq 1 ]; then
  if [ $FAIL -eq 0 ]; then
    echo '=== INFO ONLY. ALL CHECKS PASSED. ==='
  else
    echo '=== INFO ONLY. WARNINGS PRESENT (would block real run). ==='
  fi
  exit 0
fi
if [ $FAIL -eq 0 ]; then
  echo '=== GATE PASSED. Safe to launch bench. ==='
  exit 0
else
  echo '=== GATE FAILED. Fix before launching. ==='
  exit 1
fi
