#!/usr/bin/env bash
set -euo pipefail

# RunPod run script — starts Ollama and runs the tag pipeline.

REPO_DIR="${REPO_DIR:-/workspace/futo-notes}"
NOTES_DIR="${NOTES_DIR:-/workspace/notes}"
MODEL="${MODEL:-qwen3.5:4b}"
CONCURRENCY="${CONCURRENCY:-12}"

cd "$REPO_DIR"

echo "=== Starting Ollama server ==="
export OLLAMA_NUM_PARALLEL="${CONCURRENCY}"
export OLLAMA_FLASH_ATTENTION=1
ollama serve &
OLLAMA_PID=$!

echo "=== Waiting for Ollama to be ready ==="
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:11434/api/tags" > /dev/null 2>&1; then
    echo "Ollama ready after ~${i}s"
    break
  fi
  if ! kill -0 "$OLLAMA_PID" 2>/dev/null; then
    echo "ERROR: Ollama process died"
    exit 1
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:11434/api/tags" > /dev/null 2>&1; then
  echo "ERROR: Ollama failed to start within 60s"
  kill "$OLLAMA_PID" 2>/dev/null || true
  exit 1
fi

echo "=== Pulling model $MODEL ==="
ollama pull "$MODEL"

echo "=== Running tag pipeline ==="
node experiments/entity-lab/scripts/tag-run-all.mjs \
  --notes-dir "$NOTES_DIR" \
  --model "$MODEL" \
  --concurrency "$CONCURRENCY"

echo "=== Pipeline complete. Shutting down Ollama ==="
kill "$OLLAMA_PID" 2>/dev/null || true
wait "$OLLAMA_PID" 2>/dev/null || true

echo "=== Done ==="
