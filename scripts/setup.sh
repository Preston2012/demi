#!/bin/bash
# First-time setup for Demiurge.

set -euo pipefail

echo "Setting up Demiurge..."

# Create directories
mkdir -p data models backups fixtures/benchmark

# Copy example env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from example. Fill in your API keys."
fi

# Install dependencies
npm ci

# Build
npm run build

echo ""
echo "Setup complete. Next steps:"
echo "  1. Download BGE-small ONNX model to models/"
echo "  2. Edit .env with your AUTH_TOKEN (min 32 chars) and API keys"
echo "  3. Run: docker compose up"
echo "  Or without Docker: npm start"
