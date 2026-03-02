#!/usr/bin/env bash
set -euo pipefail

# RunPod run script — starts vLLM and runs the tag pipeline.

REPO_DIR="${REPO_DIR:-/workspace/futo-notes}"
NOTES_DIR="${NOTES_DIR:-/workspace/notes}"
MODEL="${MODEL:-Qwen/Qwen3-8B}"
CONCURRENCY="${CONCURRENCY:-4}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.90}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-16384}"
VLLM_PORT=8000

cd "$REPO_DIR"

echo "=== Starting vLLM server ==="
python3 -m vllm.entrypoints.openai.api_server \
  --model "$MODEL" \
  --dtype auto \
  --gpu-memory-utilization "$GPU_MEM_UTIL" \
  --max-model-len "$MAX_MODEL_LEN" \
  --trust-remote-code \
  --port "$VLLM_PORT" &

VLLM_PID=$!

echo "=== Waiting for vLLM to be ready ==="
for i in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${VLLM_PORT}/v1/models" > /dev/null 2>&1; then
    echo "vLLM ready after ~${i}s"
    break
  fi
  if ! kill -0 "$VLLM_PID" 2>/dev/null; then
    echo "ERROR: vLLM process died"
    exit 1
  fi
  sleep 1
done

# Final check
if ! curl -sf "http://127.0.0.1:${VLLM_PORT}/v1/models" > /dev/null 2>&1; then
  echo "ERROR: vLLM failed to start within 120s"
  kill "$VLLM_PID" 2>/dev/null || true
  exit 1
fi

echo "=== Running tag pipeline ==="
node experiments/entity-lab/scripts/tag-run-all.mjs \
  --notes-dir "$NOTES_DIR" \
  --vllm \
  --model "$MODEL" \
  --think \
  --concurrency "$CONCURRENCY"

echo "=== Pipeline complete. Shutting down vLLM ==="
kill "$VLLM_PID" 2>/dev/null || true
wait "$VLLM_PID" 2>/dev/null || true

echo "=== Done ==="
