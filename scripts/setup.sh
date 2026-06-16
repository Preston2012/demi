#!/bin/bash
# First-time setup for Demiurge.

set -euo pipefail

# Canonical embedding model (matches src/config.ts default: 384-dim BGE-small).
MODEL_FILE="models/bge-small-en-v1.5.onnx"
MODEL_URL="${DEMIURGE_MODEL_URL:-https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model.onnx}"
# Pin the expected sha256 here (or via DEMIURGE_MODEL_SHA256) to enforce
# verification. When empty, the script prints the computed hash so the
# operator can verify against https://huggingface.co/Xenova/bge-small-en-v1.5.
MODEL_SHA256="${DEMIURGE_MODEL_SHA256:-}"
# Minimum plausible size for the fp32 ONNX export (~127MB); guards against
# saving an HTML error page as the model. Overridable for tests only.
MODEL_MIN_BYTES="${DEMIURGE_MODEL_MIN_BYTES:-50000000}"

SKIP_MODEL="${SKIP_MODEL_DOWNLOAD:-0}"
for arg in "$@"; do
  [ "$arg" = "--skip-model" ] && SKIP_MODEL=1
done

file_size() {
  stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
}

verify_model() {
  local size
  size="$(file_size "$MODEL_FILE")"
  if [ "$size" -lt "$MODEL_MIN_BYTES" ]; then
    echo "ERROR: $MODEL_FILE is ${size} bytes; expected >= ${MODEL_MIN_BYTES}. Delete it and re-run." >&2
    return 1
  fi
  local actual
  actual="$(sha256sum "$MODEL_FILE" | awk '{print $1}')"
  if [ -n "$MODEL_SHA256" ]; then
    if [ "$actual" != "$MODEL_SHA256" ]; then
      echo "ERROR: $MODEL_FILE sha256 mismatch." >&2
      echo "  expected: $MODEL_SHA256" >&2
      echo "  actual:   $actual" >&2
      return 1
    fi
    echo "Model checksum verified ($actual)."
  else
    echo "Model sha256: $actual"
    echo "  (no pin set; verify against the model card at huggingface.co/Xenova/bge-small-en-v1.5)"
  fi
}

echo "Setting up Demiurge..."

# Create directories
mkdir -p data models backups fixtures/benchmark

# Copy example env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from example. Fill in your API keys."
fi

# Fetch the embedding model. Without it, vector search falls back to
# lexical-only (C-3: the documented cold start must reach working vector
# retrieval with no undocumented steps).
if [ "$SKIP_MODEL" = "1" ]; then
  echo ""
  echo "SKIPPED model download (--skip-model / SKIP_MODEL_DOWNLOAD=1)."
  echo "REQUIRED before vector search works:"
  echo "  1. curl -L -o $MODEL_FILE \\"
  echo "       $MODEL_URL"
  echo "  2. Re-run this script (or verify the sha256 yourself)."
elif [ -f "$MODEL_FILE" ] && verify_model; then
  echo "Embedding model already present: $MODEL_FILE"
else
  echo "Downloading BGE-small-en-v1.5 ONNX model (~130MB)..."
  curl -fL --retry 3 -o "$MODEL_FILE.tmp" "$MODEL_URL"
  mv "$MODEL_FILE.tmp" "$MODEL_FILE"
  verify_model
  echo "Model saved to $MODEL_FILE"
fi

# Install dependencies
npm ci

# Build
npm run build

echo ""
echo "Setup complete. Next steps:"
if [ "$SKIP_MODEL" = "1" ]; then
  echo "  1. Download the embedding model (see REQUIRED step above)"
  echo "  2. Edit .env with your DEMIURGE_API_KEY (min 32 chars) and API keys"
  echo "  3. Run: docker compose up"
else
  echo "  1. Edit .env with your DEMIURGE_API_KEY (min 32 chars) and API keys"
  echo "  2. Run: docker compose up"
fi
echo "  Or without Docker: npm start"
