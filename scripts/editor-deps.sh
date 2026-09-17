#!/usr/bin/env bash
# Fail fast (or self-install) when the JS deps a build recipe needs are absent
# or stale — BEFORE the 10-25 minute Rust/FFI build, not after it.
#
# `just test-ios-native` in a fresh worktree used to spend ~10 minutes of cold
# Rust iOS builds and only then die with "node_modules/.bin/vite: No such file
# or directory" (pc_7aaa5ba6c080); `just check` died on its second recipe with
# ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL / 'Command "tsx" not found', naming tsx
# rather than the missing install (pc_40406aa84bc1); and a stale install
# (node_modules present but a dependency missing) reported the missing package
# — ajv — instead of the cause, and looked like a broken test
# (pc_a725a488208e, pc_ae980350a2dc).
#
# One owner, three callers: the justfile's editor-deps recipe (a dependency of
# every recipe that touches node_modules after a Rust build) and the android
# and ios run.sh entry points, which previously checked only
# `[ -d node_modules ]` — presence, not usability.
set -euo pipefail

if [ ! -x node_modules/.bin/vite ]; then
  echo "==> node_modules missing or stale — pnpm install"
  pnpm install
  if [ ! -x node_modules/.bin/vite ]; then
    echo "ERROR: node_modules/.bin/vite is still missing after pnpm install." >&2
    echo "  The install is stale; remove node_modules and re-run: pnpm install" >&2
    exit 1
  fi
fi
