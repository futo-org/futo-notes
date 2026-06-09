#!/usr/bin/env bash
# Moved to scripts/build-rust-ios.sh (shared layout with build-rust-android.sh).
# Kept as a thin shim so apps/ios/run.sh and muscle memory keep
# working.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$ROOT/scripts/build-rust-ios.sh" "$@"
