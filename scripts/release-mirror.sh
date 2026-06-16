#!/usr/bin/env bash
#
# R29-WA-5: public mirror curation (Preston ruling 5).
#
# Builds the public "demi" snapshot from a curated allowlist, scans the staged
# tree with gitleaks + the em-dash guard, and refuses to publish on ANY hit.
# This script is the ONLY sanctioned path to the public mirror. benchmark-archive
# stays OUT of the mirror until post-re-lock (ruling 5).
#
# Usage:
#   scripts/release-mirror.sh                 # dry-run: print manifest + scan results, NO push (default, safe)
#   scripts/release-mirror.sh --dry-run       # same as above, explicit
#   scripts/release-mirror.sh --push          # run scans, then push to the 'demi' remote
#
# The 'demi' remote must be configured by the operator first:
#   git remote add demi <public-mirror-url>
# Override the remote/branch with DEMI_REMOTE / DEMI_BRANCH env vars.

set -euo pipefail

DEMI_REMOTE="${DEMI_REMOTE:-demi}"
DEMI_BRANCH="${DEMI_BRANCH:-main}"

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --push) MODE="push" ;;
    --dry-run) MODE="dry-run" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# --- copy allowlist: only these top-level paths enter the mirror ----------------
ALLOW=(
  src
  scripts
  docs
  models            # .gitkeep / placeholders only; large model blobs are gitignored
  README.md
  LICENSE
  Dockerfile
  docker-compose.yml
  package.json
  package-lock.json
  tsconfig.json
  .gitignore
  .gitleaksignore
)

# --- deny-list: removed from the staged tree after the allowlist copy -----------
# Anything secret-bearing, host-only, internal, or bench data never ships.
DENY=(
  benchmark-archive
  fixtures
  data
  docs/internal
  docs/V2_ROADMAP.md
  docs/hindsight-tempr-notes.md
  docs/cc-packets
  docs/client
  scripts/scorecard/host
  scripts/audit
  scripts/metrics
  scripts/track-a-dataset-prep
  scripts/session-scripts
  scripts/logs
  docker-compose.bench.yml
  docker-compose.clone.yml
)

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "== release-mirror: staging the public snapshot =="
for path in "${ALLOW[@]}"; do
  if [ -e "$path" ]; then
    mkdir -p "$STAGING/$(dirname "$path")"
    cp -a "$path" "$STAGING/$path"
  fi
done

# Apply the deny-list (defensive: even if an allowlisted dir contains one).
for path in "${DENY[@]}"; do
  rm -rf "${STAGING:?}/$path"
done
# Belt-and-suspenders: never ship env files, VCS, or deps.
find "$STAGING" -maxdepth 3 -name '.env*' -exec rm -f {} + 2>/dev/null || true
rm -rf "$STAGING/.git" "$STAGING"/**/node_modules 2>/dev/null || true

echo
echo "== file manifest (staged for mirror) =="
( cd "$STAGING" && find . -type f | sort )
FILE_COUNT="$(cd "$STAGING" && find . -type f | wc -l | tr -d ' ')"
echo "-- $FILE_COUNT files staged --"

# --- scan 1: gitleaks over the staged tree --------------------------------------
echo
echo "== scan 1/2: gitleaks =="
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "ERROR: gitleaks not on PATH; install it before mirroring." >&2
  exit 3
fi
GITLEAKS_OK=1
if gitleaks detect --no-git --source "$STAGING" --no-banner --exit-code 1; then
  echo "gitleaks: clean"
else
  GITLEAKS_OK=0
  echo "gitleaks: LEAKS FOUND in staged tree" >&2
fi

# --- scan 2: em-dash guard over the staged tree ---------------------------------
echo
echo "== scan 2/2: em-dash guard =="
EMDASH_OK=1
if ( cd "$STAGING" && node scripts/check-no-em-dash.mjs ); then
  echo "em-dash guard: clean"
else
  EMDASH_OK=0
  echo "em-dash guard: U+2014 found in staged tree" >&2
fi

if [ "$GITLEAKS_OK" -ne 1 ] || [ "$EMDASH_OK" -ne 1 ]; then
  echo
  echo "REFUSING TO PUBLISH: a scan failed. The mirror was NOT pushed." >&2
  exit 1
fi

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "dry-run complete: scans passed, nothing pushed. Re-run with --push to publish."
  exit 0
fi

# --- publish: snapshot commit to the demi remote --------------------------------
echo
echo "== publishing snapshot to '$DEMI_REMOTE/$DEMI_BRANCH' =="
if ! git remote get-url "$DEMI_REMOTE" >/dev/null 2>&1; then
  echo "ERROR: remote '$DEMI_REMOTE' is not configured. Run: git remote add $DEMI_REMOTE <url>" >&2
  exit 3
fi

SNAP_REPO="$(mktemp -d)"
trap 'rm -rf "$STAGING" "$SNAP_REPO"' EXIT
cp -a "$STAGING/." "$SNAP_REPO/"
SRC_SHA="$(git rev-parse --short HEAD)"
(
  cd "$SNAP_REPO"
  git init -q
  git add -A
  git commit -q -m "mirror snapshot from ${SRC_SHA}"
  git remote add "$DEMI_REMOTE" "$(git -C "$REPO_ROOT" remote get-url "$DEMI_REMOTE")"
  git push -f "$DEMI_REMOTE" "HEAD:$DEMI_BRANCH"
)
echo "published snapshot from ${SRC_SHA} to ${DEMI_REMOTE}/${DEMI_BRANCH}."
