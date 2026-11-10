# Build and test the web app and Rust workspace, plus the check/prepush umbrellas. Imported by the root justfile.

# Type-check + build the web app (pipefail so a failing tsc/vite can't hide behind `| tail`).
build: check-node-version _require-node-modules
  #!/usr/bin/env bash
  set -euo pipefail
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

# Every vitest test (app, editor package, scripts); pass files, folders or -t <name> to run only those.
test-unit *args: editor-deps
  node_modules/.bin/vitest run "$@"

# Run the quick P0 crash/IME Playwright spec (CI runs it inside test:e2e:rest).
test-e2e:
  pnpm run test:e2e:smoke

# Install browsers matching this worktree's Playwright lockfile (Chromium by default).
browser-install *browsers='chromium':
  PLAYWRIGHT_SKIP_BROWSER_GC=1 pnpm exec playwright install "$@"

# Serve this worktree for browser diagnostics without consuming file watchers; no HMR.
web-diagnostic *args:
  FUTO_VITE_NO_WATCH=1 pnpm run dev "$@"

# Run selected Playwright tests against this worktree's already-running diagnostic server.
test-e2e-reuse *args:
  PLAYWRIGHT_REUSE_DEV_SERVER=1 pnpm exec playwright test "$@"

# Run browser tests in a matching official image via rootless Podman (Linux; no host library changes).
test-browser-container browser='webkit' *args:
  node scripts/browser-container.mjs "$@"

# EXACTLY what CI's test:e2e:rest job runs (the whole Playwright web suite).
test-e2e-rest:
  pnpm run test:e2e:rest

# Cross-platform E2EE sync against the pinned sync-server release.
test-cross-platform *args: editor-deps
  pnpm run test:cross-platform "$@"

# The Rust server-backed sync suites against REAL servers (two server modes); see justfile-notes.md.
test-sync-integration *args:
  node tests/sync-integration.mjs "$@"

# Editor engine + store/core tests, Rust conformance goldens + the TS↔Rust rules differential.
test-rust:
  cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core -p futo-notes-merge
  cargo test -p futo-notes-model --test conformance
  cargo test -p futo-notes-license
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

# Run a selected Cargo test target/filter; complete owner gates remain test-rust/test-rust-full.
test-rust-focused +args:
  cargo test "$@"

# Compile and execute the portable WASM editor against a real background Rust store.
test-editor-wasm:
  node scripts/test-editor-wasm.mjs

# Install the pinned, verified nextest binary without changing the Rust toolchain.
install-nextest:
  sh ci/install-nextest.sh

# All ordinary sync tests with per-test timeouts, then Cargo doctests; server tests stay ignored.
test-sync:
  node scripts/rust-tests.mjs sync

# Prove a deliberately deadlocked test fails with its name under the actual timeout policy.
test-sync-timeout-proof:
  node scripts/rust-test-timeout-proof.mjs

# Prove model fixture embedding and dynamic license goldens survive checkout relocation.
test-conformance-relocation:
  node scripts/conformance-relocation-proof.mjs

# The full Rust workspace + doctests + differential; sync uses bounded per-test processes.
test-rust-full:
  mkdir -p dist
  node scripts/rust-tests.mjs workspace
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

# Run the futo-notes CLI from source (a debug build: its own futo-notes-cli-dev settings).
cli *args:
  cargo run -q -p futo-notes-cli -- "$@"

# The Linux CLI binary: target/release/futo-notes.
build-cli:
  cargo build --release -p futo-notes-cli

# A static x86_64 CLI that runs on any Linux distro: target/x86_64-unknown-linux-musl/release/futo-notes.
# Needs a musl C compiler for ring and zstd (Debian/Ubuntu: musl-tools).
build-cli-static:
  rustup target add x86_64-unknown-linux-musl
  cargo build --release --locked -p futo-notes-cli --target x86_64-unknown-linux-musl

# Every CLI test, including sign-in and sync against the pinned sync server.
test-cli:
  #!/usr/bin/env bash
  set -euo pipefail
  FUTO_NOTES_E2EE_SERVER_BIN="${FUTO_NOTES_E2EE_SERVER_BIN:-$(node scripts/lib/sync-server.mjs path)}"
  export FUTO_NOTES_E2EE_SERVER_BIN
  cargo test -p futo-notes-cli -- --include-ignored

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

# The normal pre-merge umbrella, scoped to what your branch changed vs origin/main (plan printed first).
# Scope rules: scripts/check-scoped.mjs. `--plan` prints the plan without running it.
check *flags: check-node-modules check-node-version _require-node-modules toolbar-spec-check title-spec-check coin-check lint-swift
  node scripts/check-scoped.mjs "$@"

# Every check whatever changed: specs, arch gates, Rust conformance, lint, tests, build.
check-full: check-node-modules check-node-version _require-node-modules toolbar-spec-check title-spec-check coin-check lint-swift
  node scripts/check-scoped.mjs --full

# Maximal pre-push gate: `check-full` + full Rust workspace + full E2E + cross-platform sync.
prepush: check-full test-rust-full
  #!/usr/bin/env bash
  set -euo pipefail
  # --retries=1 absorbs the local 30s timeout's flakes, not real bugs; see justfile-notes.md.
  pnpm exec playwright test --retries=1
  pnpm run test:cross-platform
  bash scripts/run-ios-stories-if-available.sh
  echo "prepush green — check + rust workspace + full e2e + cross-platform sync + available iOS stories all passed"
