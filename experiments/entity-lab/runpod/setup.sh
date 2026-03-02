#!/usr/bin/env bash
set -euo pipefail

# RunPod setup script for the tag pipeline.
# Image: runpod/pytorch:2.8.0-py3.12-cuda12.8.1-devel-ubuntu24.04
# GPU: A100 80GB SXM (~$1.64/hr)

echo "=== Installing Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "=== Installing Ollama ==="
curl -fsSL https://ollama.com/install.sh | sh

echo "=== Cloning repo ==="
REPO_URL="${REPO_URL:-https://gitlab.futo.org/justin/futo-notes.git}"
REPO_DIR="${REPO_DIR:-/workspace/futo-notes}"

if [ ! -d "$REPO_DIR" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
npm install --ignore-scripts

echo "=== Pre-pulling model ==="
MODEL="${MODEL:-qwen3.5:4b}"
ollama serve &
OLLAMA_PID=$!
sleep 3
ollama pull "$MODEL"
kill "$OLLAMA_PID" 2>/dev/null || true

echo "=== Setup complete ==="
echo "Run: bash experiments/entity-lab/runpod/run.sh"
