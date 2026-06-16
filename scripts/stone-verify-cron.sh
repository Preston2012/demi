#!/usr/bin/env bash
# Wedge 1.5 Phase 4: STONE audit-chain verification wrapper.
# Invoked by systemd timer or any periodic scheduler. Exits 0 on clean
# chain, 2 on integrity failure (also fires a webhook), 3 on crash.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$DIR"
exec node dist/cron/verify-audit-chain.js "$@"
