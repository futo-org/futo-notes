# The supporter coin, generated-spec checks, and repo gates. Imported by the root justfile.

# ── The FUTO supporter coin (Blender -> all three shells) ──
# The coin is ONE object, modeled in assets/coin/build-coin.py and exported to
# three files: futo-coin.glb (desktop three.js + Android Filament), futo-coin.usdz
# (iOS RealityKit) and studio-env.hdr, the small studio every shell reflects off
# it. Gold is a metal; a metal with nothing to reflect renders black, which is
# why the environment is an asset and not a nicety.
# Rebuild the coin from its Blender source (needs Blender 5.x on PATH).
coin:
  #!/usr/bin/env bash
  set -euo pipefail
  command -v blender >/dev/null || { echo "blender is not on PATH - install it (dnf install blender) or see assets/coin/build-coin.py" >&2; exit 1; }
  blender --background --factory-startup --python assets/coin/build-coin.py -- "$PWD/assets/coin"
  # Android's Filament needs the studio prefiltered into a cubemap; the other
  # two shells do that themselves at load time. Downloads a pinned cmgen once.
  node scripts/build-coin-ibl.mjs
  node scripts/check-coin-assets.mjs

# Fail if the exports no longer match build-coin.py, or were hand-edited (M8),
# and if scripts/lib/studio-env.mjs no longer rebuilds the shipped studio.
# Needs no Blender, which is why it can run in CI and in `just check`.
coin-check:
  node scripts/check-coin-assets.mjs

# Per-shell exposure (no regeneration), material roughness and color, the room,
# and each of the five lamps. It reads out what percentage of the coin is blown
# out and will sweep 360 degrees to find the worst angle, so "too bright at some
# angles" becomes a number. Nothing is written to the repo: the page prints the
# constants and names the files to paste them into. Static server on a
# slot-derived port, Ctrl-C to stop.
# Play with every dial that decides how bright the supporter coin is.
coin-tuner:
  @node scripts/coin-tuner.mjs

# Regenerate the native toolbar specs from packages/editor/src/toolbar.ts.
toolbar-spec:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --write

# Fail if a generated native toolbar spec has drifted from the manifest.
toolbar-spec-check:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --check

# Regenerate the native title-validation constants from packages/editor/src/filename.ts.
title-spec:
  pnpm exec tsx scripts/gen-title-spec.ts --write

# Fail if a generated native title spec has drifted from the manifest.
title-spec-check:
  pnpm exec tsx scripts/gen-title-spec.ts --check

# Fail on an unreachable or unregistered Tauri command (see the script for the allowlist).
check-command-reachability:
  node scripts/check-command-reachability.mjs

# Fail on a Tauri IPC import outside src/lib/platform/** (see the script for the allowlist).
check-platform-discipline:
  node scripts/check-platform-discipline.mjs

# Regenerate the native bridge-coverage specs from packages/editor/src/bridge.ts.
bridge-spec:
  pnpm exec tsx scripts/gen-bridge-spec.ts --write

# Fail if the generated native bridge specs have drifted from bridge.ts.
bridge-spec-check:
  pnpm exec tsx scripts/gen-bridge-spec.ts --check

# Generate TypeScript records from the Rust-owned Tauri sync IPC contract.
sync-contract:
  mkdir -p dist
  FUTO_UPDATE_SYNC_CONTRACT=1 cargo test -p futo-notes-tauri generated_typescript_contract_is_current

# Fail on a stale or missing entry in the drift registry (see the script for details).
check-drift:
  node scripts/drift-check.mjs

# List every tracked agent-authored file over the 5,000-token pre-commit limit.
check-file-tokens:
  node scripts/check-file-tokens.mjs --all

# Fail if any instruction surface teaches OS-level input or a process-name kill (see the script).
check-qa-input-safety:
  node scripts/check-qa-input-safety.mjs

# Fail if a theme swap repaints any surface at a different pace than the rest of the window.
check-theme-single-pace:
  node scripts/check-theme-single-pace.mjs

# Fail on a broken `just`/`pnpm run`/repo-path reference in an instruction surface.
check-agent-docs:
  node scripts/check-agent-docs.mjs

# Run the architecture gates locally: the portable set CI's mandatory test job runs
# (`check:arch-gate:portable`) plus the Tauri sync-contract test.
arch-gate:
  pnpm run check:arch-gate

# Validate the store release notes (all files, or one tag's); see justfile-notes.md.
#   just release-notes-check            # every committed file
#   just release-notes-check v1.7.2     # one tag
release-notes-check tag="":
  @node scripts/release-notes.mjs {{ if tag == "" { "--all" } else { "--tag " + tag + " --check" } }}

