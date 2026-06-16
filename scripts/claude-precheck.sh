#!/bin/bash
# claude-precheck.sh, environment sanity check
# Run at session start. Surfaces every state Claude commonly forgets.
# Place at /root/scalpel-ik/claude-precheck.sh on Baseline,
# /root/demiurge/scripts/claude-precheck.sh on CAX11/CAX21.

set +e   # informational, never abort
echo "=== CLAUDE PRECHECK $(date -u +%FT%TZ) ==="

# Host identity
HOST=$(cat /etc/host-identity 2>/dev/null || hostname || echo UNKNOWN)
echo "Host: $HOST"

# Where am I
PWD_NOW=$(pwd)
echo "PWD:  $PWD_NOW"

# NODE_ENV trap (CAX21 always tripped this)
if [ "${NODE_ENV:-}" = "production" ]; then
  echo "  ⚠ NODE_ENV=production set globally on this host."
  echo "  ⚠ Every launcher must: unset NODE_ENV; export NODE_ENV=development"
  echo "  ⚠ npm install will skip devDependencies AND not link .bin without this fix."
fi

# Repo state if in /root/demiurge
if [ -d "/root/demiurge/.git" ]; then
  cd /root/demiurge
  echo "Branch: $(git branch --show-current)"
  echo "Commit: $(git log -1 --oneline)"
  echo "Origin: $(git remote get-url origin 2>/dev/null)"
  DIRTY=$(git status --porcelain | wc -l)
  if [ $DIRTY -gt 0 ]; then
    echo "  ⚠ Working tree dirty: $DIRTY files. Pre-bench gate will fail."
    git status --short | head -5
  else
    echo "  Tree clean ✓"
  fi
  
  # Local vs origin
  git fetch origin >/dev/null 2>&1
  LOCAL=$(git rev-parse HEAD 2>/dev/null)
  REMOTE=$(git rev-parse @{u} 2>/dev/null || echo none)
  if [ "$REMOTE" = "none" ]; then
    echo "  No upstream"
  elif [ "$LOCAL" = "$REMOTE" ]; then
    echo "  In sync with origin ✓"
  else
    echo "  ⚠ Local diverges from origin (local $LOCAL, remote $REMOTE)"
  fi
fi

# node_modules .bin presence (Sprint 1 install gotcha)
if [ -f /root/demiurge/package.json ]; then
  for tool in tsx vitest tsc; do
    if [ -x /root/demiurge/node_modules/.bin/$tool ]; then
      echo "  $tool ✓"
    else
      echo "  ⚠ $tool MISSING, run: cd /root/demiurge && unset NODE_ENV && export NODE_ENV=development && npm install --include=dev && npm rebuild --include=dev"
    fi
  done
fi

# Provider keys
if [ -f /root/demiurge/.env ]; then
  cd /root/demiurge
  for k in OPENAI_API_KEY DEEPSEEK_API_KEY MISTRAL_API_KEY XAI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY; do
    if grep -qE "^$k=" .env; then echo "  $k ✓"; else echo "  ⚠ $k MISSING"; fi
  done
  for k in DEMIURGE_API_KEY DEMIURGE_DB_KEY AUTH_TOKEN; do
    if grep -qE "^$k=" .env; then echo "  $k ✓"; else echo "  -- $k absent (host-specific)"; fi
  done
fi

# Cache state
if [ -f /root/demiurge/fixtures/cache/cache.db ]; then
  SIZE=$(stat -c %s /root/demiurge/fixtures/cache/cache.db 2>/dev/null || echo 0)
  echo "  Cache DB: $((SIZE / 1024))K"
else
  echo "  Cache DB: none (cold)"
fi

# Brain count if Baseline
if [ -f /root/scalpel-ik/claude-brain.db ]; then
  COUNT=$(sqlite3 /root/scalpel-ik/claude-brain.db "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "?")
  echo "  Brain memories: $COUNT"
fi

# In-flight benches
INFLIGHT=$(pgrep -af 'tsx.*benchmark|tsx.*runner' 2>/dev/null | grep -v defunct | grep -v claude-precheck | grep -v pgrep)
if [ -n "$INFLIGHT" ]; then
  echo "  ⚠ Bench in flight on this host:"
  echo "$INFLIGHT" | head -3
fi

echo "=== END PRECHECK ==="
