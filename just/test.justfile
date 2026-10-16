# Build and test the web app and Rust workspace, plus the check/prepush umbrellas. Imported by the root justfile.

# Type-check + build the web app (pipefail so a failing tsc/vite can't hide behind `| tail`).
build: check-node-version _require-node-modules
  #!/usr/bin/env bash
  set -euo pipefail
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

# Run the minimal (fast-loop) test suite.
test:
  pnpm run test:minimal

# Run ONE test file or -t pattern (installs deps if the worktree is fresh).
test-one *args:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -d node_modules ] || { echo "==> node_modules missing — pnpm install"; pnpm install; }
  node_modules/.bin/vitest run "$@"

# Run unit tests (vitest, jsdom).
test-unit:
  pnpm run test:unit

# Run the editor package's test suite.
test-editor:
  pnpm run test:editor

# Run the Playwright smoke E2E suite.
test-e2e:
  pnpm run test:e2e:smoke

# EXACTLY what CI's test:e2e:rest job runs (everything but the P0 crash/IME spec).
test-e2e-rest:
  pnpm run test:e2e:rest

# Cross-platform E2EE sync against the pinned sync-server release.
test-cross-platform *args: editor-deps
  pnpm run test:cross-platform "$@"

# The Rust server-backed sync suites against REAL servers (two server modes); see justfile-notes.md.
test-sync-integration *args:
  node tests/sync-integration.mjs "$@"

# Rust conformance goldens + the TS↔Rust title-rules differential.
test-rust:
  cargo test -p futo-notes-model --test conformance
  cargo test -p futo-notes-license
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

# The full Rust workspace + the differential.
test-rust-full:
  mkdir -p dist
  cargo test --workspace
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

# Shared search engine correctness; see crates/futo-notes-search/benches/search.rs.
test-search *args:
  cargo test -p futo-notes-search "$@"

# Reproducible synthetic-vault benchmarks (Criterion; target/criterion). Override
# SEARCH_BENCH_NOTES for a different corpus size.
bench-search *args:
  cargo bench -p futo-notes-search --bench search -- "$@"

# Vault-open cost (bootstrap_with_search, bootstrap, startup_listing) over a
# realistic synthetic vault; see crates/futo-notes-store/benches/vault_open.rs.
# Override VAULT_BENCH_NOTES for a different corpus size.
bench-vault *args:
  cargo bench -p futo-notes-store --bench vault_open -- "$@"

# ── Remote (Linux) test execution over Tailscale; mechanism: scripts/remote-test.mjs ──
# `node scripts/remote-test.mjs --doctor|--help|<recipe>` runs any other portable recipe
# remotely (`--doctor` reports what jfedora has; `<recipe>` accepts `--rsync`/flags — see
# docs/remote-testing.md). `remote-sync` is the one wrapper kept as a `just` recipe.

# Cross-platform E2EE sync against the pinned sync-server release, remotely.
remote-sync *flags:
  node scripts/remote-test.mjs "$@" test-cross-platform

# The normal pre-merge umbrella: specs, arch gates, Rust conformance, lint, tests, build.
check: check-node-modules check-node-version _require-node-modules toolbar-spec-check title-spec-check coin-check arch-gate lint-swift test-rust rust-format-check rust-lint
  #!/usr/bin/env bash
  # pipefail: see `build:` above — a failing tsc/vite build must not hide behind `| tail`.
  set -euo pipefail
  pnpm run lint
  pnpm run check:svelte
  pnpm run format:check
  pnpm run test:full
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

# Maximal pre-push gate: `check` + full Rust workspace + full E2E + cross-platform sync.
prepush: check test-rust-full
  #!/usr/bin/env bash
  set -euo pipefail
  # --retries=1 absorbs the local 30s timeout's flakes, not real bugs; see justfile-notes.md.
  pnpm exec playwright test --retries=1
  pnpm run test:cross-platform
  bash scripts/run-ios-stories-if-available.sh
  echo "prepush green — check + rust workspace + full e2e + cross-platform sync + available iOS stories all passed"
