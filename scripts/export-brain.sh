#!/bin/bash
# Export all memories as JSON via REST API.
# Requires DEMIURGE_API_KEY if auth is enabled.

set -euo pipefail

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3100}"
OUTPUT="${1:-brain_export_$(date +%Y%m%d_%H%M%S).json}"

# Build curl argv as an array so values with shell metacharacters cannot
# be re-parsed by the shell. The previous version used `eval` on an
# interpolated header string, which was vulnerable to command injection
# when DEMIURGE_API_KEY contained quotes or `;`.
CURL_ARGS=(-s)
if [ -n "${DEMIURGE_API_KEY:-}" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${DEMIURGE_API_KEY}")
fi

echo "Exporting brain from http://${HOST}:${PORT}..."

curl "${CURL_ARGS[@]}" "http://${HOST}:${PORT}/api/v1/export" | \
  python3 -m json.tool > "${OUTPUT}"

echo "Brain exported: ${OUTPUT}"
