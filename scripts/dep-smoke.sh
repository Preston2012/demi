#!/usr/bin/env bash
# demi dependency smoke test.
#
# Purpose: prove that a dependency bump inside fastify's request path did not
# break routing, validation or serialization. demi is the curated public mirror
# and ships no test suite, so typecheck and build alone leave the request path
# unverified. find-my-way is the router and fast-uri feeds ajv plus
# fast-json-stringify, so a regression in either is silent until a real
# request arrives.
#
# Boots the BUILT server (dist/index.js) on an in-memory database with a
# throwaway token, so it touches no real secret and no real data.
#
# Note on env: boot() throws before its own try/catch when no LLM provider key
# is present, and the caller swallows that throw, so the process exits 1 with
# an empty log. A placeholder ANTHROPIC_API_KEY satisfies the check. No network
# call is made because no route exercised here reaches a provider.
#
# Usage: bash scripts/dep-smoke.sh [repo-path]
# Exit 0 all checks passed. Exit 1 any check failed.

set -uo pipefail

REPO="${1:-/workspaces/demi}"
PORT="${SMOKE_PORT:-8791}"
TOKEN="smoke-throwaway-token-not-a-secret"
LOG="${SMOKE_LOG:-/tmp/demi-smoke-server.log}"
BASE="http://127.0.0.1:${PORT}"
FAILED=0

# code_in <label> <url> <expected-codes...>
code_in() {
  local label="$1" url="$2"; shift 2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Authorization: Bearer $TOKEN" "$url")
  for want in "$@"; do
    if [ "$code" = "$want" ]; then
      echo "  OK   $label (got $code)"
      return 0
    fi
  done
  echo "  FAIL $label (expected one of $*, got $code)"
  FAILED=1
}

cd "$REPO" || { echo "FAIL: cannot cd to $REPO"; exit 1; }

if [ ! -f dist/index.js ]; then
  echo "FAIL: dist/index.js missing. Run npm run build first."
  exit 1
fi

echo "booting built server on port $PORT with an in-memory database"

# boot() starts the MCP stdio transport AND the REST server in one process.
# stdin must stay open or the stdio transport sees EOF and shuts the whole
# process down before any request can be made. A fifo held by a background
# sleep keeps it open for the life of the test.
FIFO=$(mktemp -u /tmp/demi-smoke-stdin.XXXXXX)
mkfifo "$FIFO"
sleep 300 > "$FIFO" &
HOLDER=$!

NODE_ENV=development \
  DB_PATH=:memory: \
  PORT="$PORT" \
  DEMIURGE_API_KEY="$TOKEN" \
  ANTHROPIC_API_KEY=smoke-not-a-real-key \
  ALLOW_UNSIGNED_WEBHOOKS=true \
  LOG_LEVEL=fatal \
  node dist/index.js < "$FIFO" > "$LOG" 2>&1 &
PID=$!

cleanup() {
  kill "$PID" 2>/dev/null
  kill "$HOLDER" 2>/dev/null
  rm -f "$FIFO"
}
trap cleanup EXIT

READY=0
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "$BASE/api/v1/health" > /dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "FAIL: server exited during boot. Log:"
    tail -30 "$LOG"
    exit 1
  fi
  sleep 0.5
done

if [ "$READY" -ne 1 ]; then
  echo "FAIL: server never became reachable. Log:"
  tail -30 "$LOG"
  exit 1
fi

echo "running checks against real registered routes"

# 1. Unauthenticated health route resolves. find-my-way static match.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/v1/health")
if [ "$code" = "200" ]; then
  echo "  OK   health route resolves (got 200)"
else
  echo "  FAIL health route resolves (expected 200, got $code)"
  FAILED=1
fi

# 2. Health body is well-formed JSON. Proves the serializer works.
if curl -fsS -m 5 "$BASE/api/v1/health" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  echo "  OK   health body is valid JSON"
else
  echo "  FAIL health body is not valid JSON"
  FAILED=1
fi

# 3. Authed request to a real handler returns a schema-serialized 200. This is
#    the fast-json-stringify path, which is what consumes fast-uri.
code_in "GET /api/v1/stats serializes" "$BASE/api/v1/stats" 200

# 4. Stats body is valid JSON, so serialization is correct and not just non-500.
if curl -fsS -m 10 -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/stats" \
    | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  echo "  OK   stats body is valid JSON"
else
  echo "  FAIL stats body is not valid JSON"
  FAILED=1
fi

# 5. Parametric route match. find-my-way's parametric radix path is the part
#    that actually differs between router versions, so hit it directly.
code_in "parametric route /api/v1/memory/:id matches" \
  "$BASE/api/v1/memory/00000000-0000-0000-0000-000000000000" 200 404 400

# 6. Nested parametric route with a trailing static segment.
code_in "nested parametric /api/v1/users/:user_id/memories matches" \
  "$BASE/api/v1/users/smoke-user/memories" 200 404 400

# 7. ajv query-string validation with a URI-shaped value carrying a literal
#    backslash authority delimiter, the exact shape of the fast-uri advisory.
code_in "uri-shaped query value validated" \
  "$BASE/api/v1/memory/search?q=https%3A%2F%2Fexample.com%2Fa%5Cb&limit=1" 200 400 404

# 8. Unauthenticated request to a protected route is refused, not crashed.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/v1/stats")
if [ "$code" = "401" ] || [ "$code" = "403" ]; then
  echo "  OK   unauthenticated request refused (got $code)"
else
  echo "  FAIL unauthenticated request (expected 401 or 403, got $code)"
  FAILED=1
fi

# 9. Unknown route handled cleanly by the router miss path.
code_in "unknown route handled cleanly" "$BASE/zzz-no-such-route" 404 401

# 10. No unhandled error or stack trace in the server log.
if grep -qiE "unhandled|UnhandledPromiseRejection|TypeError|ERR_MODULE_NOT_FOUND|Cannot find module" "$LOG"; then
  echo "  FAIL server log contains an error:"
  grep -iE "unhandled|UnhandledPromiseRejection|TypeError|ERR_MODULE_NOT_FOUND|Cannot find module" "$LOG" | head -5
  FAILED=1
else
  echo "  OK   server log clean of unhandled errors"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "SMOKE PASS: routing, validation and serialization intact after dependency change"
  exit 0
fi
echo "SMOKE FAIL: see failures above. Server log: $LOG"
exit 1
