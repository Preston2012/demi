#!/bin/bash
# Verification battery for "LIKELY SHIPPED. Verify." items in STATE.md.
#
# D2: Decommission TEMPORAL_NORMALIZE -> grep src/ for any LIVE reference
#     (excludes verifier script self-references).
# A5: C1 LME date-anchoring in-band per-session -> check LME runner
#     wires haystack_dates -> per-session asserted_at at ingest.

set -uo pipefail
cd /root/demiurge

echo "================================================================"
echo "VERIFICATION BATTERY: D2 + A5"
echo "Commit: $(git rev-parse --short HEAD)"
echo "Date:   $(date -u +%FT%TZ)"
echo "================================================================"

# D2
echo ""
echo "--- D2: TEMPORAL_NORMALIZE decommission ---"
HITS=$(grep -rE "TEMPORAL_NORMALIZE" src/ scripts/ 2>/dev/null \
       | grep -v "^Binary" \
       | grep -v "scripts/verify-d2-a5.sh" \
       | wc -l)
echo "Live references in src/ + scripts/ (excluding this verifier): $HITS"
if [ "$HITS" -eq 0 ]; then
  echo "D2: PASS - zero live references. Decommission verified."
else
  echo "D2: FAIL - live references remain:"
  grep -rnE "TEMPORAL_NORMALIZE" src/ scripts/ 2>/dev/null \
    | grep -v "^Binary" \
    | grep -v "scripts/verify-d2-a5.sh" | head -20
fi

# A5
echo ""
echo "--- A5: C1 LME date-anchoring in-band per-session ---"
LME_RUNNER=scripts/benchmark-longmemeval.ts
if [ ! -f "$LME_RUNNER" ]; then
  echo "A5: FAIL - $LME_RUNNER not found"
else
  # Look for the exact wire-up pattern: haystack_dates -> per-session asserted_at
  HAS_DATES=$(grep -cE "haystack_dates" "$LME_RUNNER" 2>/dev/null || echo 0)
  HAS_PER_SESSION=$(grep -cE "asserted_at:\s*sessionAsserted|asserted_at:\s*sessionDate" "$LME_RUNNER" 2>/dev/null || echo 0)
  echo "  haystack_dates references in LME runner: $HAS_DATES"
  echo "  per-session asserted_at wire-up:         $HAS_PER_SESSION"
  if [ "$HAS_DATES" -gt 0 ] && [ "$HAS_PER_SESSION" -gt 0 ]; then
    echo "A5: PASS - haystack_dates wired to per-session asserted_at at ingest."
    echo "  Evidence:"
    grep -nE "haystack_dates|asserted_at:\s*session" "$LME_RUNNER" | head -10 | sed 's/^/    /'
  else
    echo "A5: FAIL - wire-up not found in expected shape."
  fi
fi

echo ""
echo "================================================================"
echo "If both PASS, mark D2 + A5 as SHIPPED-VERIFIED in STATE.md and"
echo "brain-write the verification (e.g. 'D2 TEMPORAL_NORMALIZE confirmed"
echo "decommissioned at ad30d77' and 'A5 LME date-anchoring confirmed"
echo "in-band per-session at ad30d77')."
echo "================================================================"
