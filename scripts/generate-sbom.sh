#!/usr/bin/env bash
# Wedge 1.5 Phase 5: SBOM generation in CycloneDX 1.5 JSON format.
#
# Output: ./sbom/demiurge-{commit}-{date}.cdx.json
# Schema: https://cyclonedx.org/docs/1.5/json/
#
# Run before releases or on demand for security questionnaires.

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"

COMMIT="$(git rev-parse --short HEAD)"
DATE="$(date -u +%Y-%m-%d)"
OUTDIR="./sbom"
OUTFILE="${OUTDIR}/demiurge-${COMMIT}-${DATE}.cdx.json"

mkdir -p "$OUTDIR"

node_modules/.bin/cyclonedx-npm \
  --output-format JSON \
  --output-file "$OUTFILE" \
  --spec-version 1.5 \
  --omit dev \
  --validate

echo "SBOM written: $OUTFILE"
echo "Components: $(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUTFILE','utf-8')).components.length)")"
