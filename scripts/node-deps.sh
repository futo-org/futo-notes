#!/usr/bin/env bash
# Shell entry point for the `node-deps` just recipe. JavaScript recipes call
# scripts/node-deps.mjs directly so the same checks work on Windows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/node-deps.mjs" --root "$PWD"
