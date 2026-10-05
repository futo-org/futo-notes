#!/usr/bin/env bash
# Portable shell entry point for native build scripts. JavaScript recipes call
# scripts/editor-deps.mjs directly so the same checks work on Windows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/editor-deps.mjs" --root "$PWD"
