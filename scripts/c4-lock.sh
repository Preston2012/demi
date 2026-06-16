#!/bin/bash
# S69 C4 LOCK script.
# Runs after matrix completes + aggregator confirms decision.
# Updates golden-config.json with new baselines + manifest entry.
# Updates DEMIURGE_STATE.md §3 baselines section.
# Commits to main with C4 message.
#
# DOES NOT run automatically. Preston reviews aggregator output, then
# runs this with the chosen config as argument.
#
# Usage:
#   bash c4-lock.sh "EP|p25b=off" 54.62 "ad30d77"
#
# Args:
#   $1 = chosen config label (e.g. "EP|p25b=off")
#   $2 = jScore percent (e.g. 54.62)
#   $3 = commit sha (e.g. ad30d77)

set -euo pipefail

CONFIG="${1:?missing config label}"
SCORE="${2:?missing jScore percent}"
COMMIT="${3:?missing commit sha}"
DATE_ISO=$(date -u +%Y-%m-%d)
TIMESTAMP=$(date -u +%FT%TZ)

cd /root/demiurge

# Pre-flight
git status --porcelain | grep -v "^??" && { echo "ERROR: dirty tree"; exit 1; } || true
[ "$(git branch --show-current)" = "main" ] || { echo "ERROR: not on main"; exit 1; }

# Verify aggregator artifact exists
SUMMARY=/tmp/s69-matrix-summary-${COMMIT}.json
[ -f "$SUMMARY" ] || { echo "ERROR: $SUMMARY missing - run aggregator first"; exit 1; }

# Build the new baselines block in a working file
python3 << PYEOF
import json
import re
from datetime import datetime

CFG = "$CONFIG"
SCORE = $SCORE
COMMIT = "$COMMIT"
DATE = "$DATE_ISO"
TS = "$TIMESTAMP"

# Read existing golden-config
with open("/root/demiurge/golden-config.json") as f:
    gc = json.load(f)

# Update version
prev_version = gc["_meta"]["version"]
gc["_meta"]["version"] = prev_version + 1
gc["_meta"]["lockedAt"] = DATE
gc["_meta"]["lockedBy"] = "S69 C4"

# Update locomo_mini baseline to new honest number
summary = json.load(open("/tmp/s69-matrix-summary-{}.json".format(COMMIT)))
chosen = summary["groups"].get(CFG, {})

gc["baselines"]["locomo_mini"] = {
    "jScore": SCORE,
    "source": "S69 C4 baseline matrix - {} config, n={}, stdev={}pp".format(
        CFG, chosen.get("n", "?"), round(chosen.get("stdev", 0)*100, 2)
    ),
    "commit": COMMIT,
    "date": DATE,
    "matrix_summary_path": "/tmp/s69-matrix-summary-{}.json".format(COMMIT),
    "raw_scores": chosen.get("raw_scores", []),
    "config_label": CFG,
}

# Also stash full matrix at top-level for audit
gc["baselines"]["_s69_matrix"] = {
    "commit": COMMIT,
    "expected_cells": summary["expected"],
    "actual_cells": summary["actual"],
    "groups": summary["groups"],
    "locked_at": TS,
}

# Mark old stale flags removed
for key in ("locomo_routed", "beam_micro", "lme_micro"):
    if key in gc["baselines"] and "stale_S64" in gc["baselines"][key]:
        del gc["baselines"][key]["stale_S64"]
        gc["baselines"][key]["status"] = "stale - awaiting S69+ re-lock"

# Append changelog
gc["changelog"].append({
    "version": gc["_meta"]["version"],
    "date": DATE,
    "session": "S69 C4",
    "change": "Lock LOCOMO mini baseline from honest 27-cell matrix on commit {}. Simplest config within variance band: {} at {}%. Plan 2.5b default OFF per Wave 1 revised (PR #61). Stack flags EB+H+EST add <1pp over EP-only, within variance.".format(
        COMMIT, CFG, SCORE
    ),
    "evidence": "27 cells, n=3 per config, 2-concurrent on CAX21. Full matrix in baselines._s69_matrix and /tmp/s69-matrix-summary-{}.json".format(COMMIT),
})

with open("/root/demiurge/golden-config.json", "w") as f:
    json.dump(gc, f, indent=2)
    f.write("\n")

print("golden-config.json updated to version", gc["_meta"]["version"])
PYEOF

# Update DEMIURGE_STATE.md baseline line
python3 << PYEOF
import re

with open("/root/demiurge/DEMIURGE_STATE.md") as f:
    s = f.read()

# Replace the "LOCOMO mini 296Q baseline:" line
new_line = "- LOCOMO mini 296Q baseline: **{}%** at {} (S69 C4 lock, config: {})".format(
    "$SCORE", "$COMMIT", "$CONFIG"
)
s = re.sub(
    r"- LOCOMO mini 296Q baseline:.*",
    new_line,
    s,
)

# Update Last updated header
s = re.sub(
    r"\*\*Last updated:\*\*.*",
    "**Last updated:** {} (S69 close, C4 locked)".format("$DATE_ISO"),
    s,
)

# Mark C4 SHIPPED
s = s.replace("| **C4** | Lock honest baselines in golden-config.json + run manifest | 🔄 IN FLIGHT TONIGHT. |",
              "| **C4** | Lock honest baselines in golden-config.json + run manifest | SHIPPED S69. {}% on {}, config {}. |".format("$SCORE", "$COMMIT", "$CONFIG"))

with open("/root/demiurge/DEMIURGE_STATE.md", "w") as f:
    f.write(s)

print("DEMIURGE_STATE.md updated")
PYEOF

# Show diff
echo ""
echo "=== DIFF ==="
git diff --stat golden-config.json DEMIURGE_STATE.md
echo ""
echo "Review the above. If looks good, commit with:"
echo ""
echo "  git add golden-config.json DEMIURGE_STATE.md"
echo "  git commit -m \"S69 C4: lock honest baselines from clean matrix\""
echo "  git push origin main"
echo ""
echo "Then brain-write the lock (use c4-brain-write.sh)."
