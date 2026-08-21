#!/usr/bin/env bash
# Local-only native iOS story gate shared by `just prepush` and the pre-push
# hook. A missing environment is a visible boundary, never a silent green.
set -euo pipefail

if [ "${FUTO_SKIP_IOS_STORIES:-0}" = "1" ]; then
  echo "================ iOS DEVICE STORIES SKIPPED ================"
  echo "FUTO_SKIP_IOS_STORIES=1 was set; sustained autosave typing was not tested."
  echo "============================================================"
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "================ iOS DEVICE STORIES SKIPPED ================"
  echo "This host is not macOS; sustained autosave typing was not tested."
  echo "============================================================"
  exit 0
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "================ iOS DEVICE STORIES SKIPPED ================"
  echo "xcodebuild is unavailable; sustained autosave typing was not tested."
  echo "============================================================"
  exit 0
fi

if ! command -v "${AXE_BIN:-axe}" >/dev/null 2>&1; then
  echo "================ iOS DEVICE STORIES SKIPPED ================"
  echo "AXe is unavailable; sustained autosave typing was not tested."
  echo "Install it per .claude/skills/verify/references/ios.md or set AXE_BIN."
  echo "============================================================"
  exit 0
fi

# Always resolve the target through the pool. An ambient SIM may name a
# personal or another worktree's simulator; the story runner independently
# verifies ownership before it touches the app container or sends input.
if ! claim_output=$(just qa-claim ios 2>&1); then
  echo "================ iOS DEVICE STORIES SKIPPED ================"
  echo "No pooled simulator could be claimed; sustained autosave typing was not tested."
  printf '%s\n' "$claim_output"
  echo "============================================================"
  exit 0
fi

SIM=$(printf '%s\n' "$claim_output" | sed -n 's/^export SIM=//p' | tail -1)
if [ -z "$SIM" ]; then
  echo "================ iOS DEVICE STORIES SKIPPED ================"
  echo "The simulator claim returned no SIM; sustained autosave typing was not tested."
  printf '%s\n' "$claim_output"
  echo "============================================================"
  exit 0
fi

printf '%s\n' "$claim_output"
export SIM
just test-ios-stories
