# Install, format, lint, and clean this worktree. Imported by the root justfile.

# Install pnpm dependencies.
install:
  pnpm install
  @node scripts/check-node-modules.mjs

# Provision pinned Node when needed, then install dependencies/check prerequisites.
setup *args:
  @bash scripts/dev-env.sh --install node scripts/setup-worktree.mjs "$@"

# Preserve a recipe's log, source identity and artifacts in a unique run directory.
verify-run +args:
  @node scripts/verify-run.mjs "$@"

# Lint the TypeScript/Svelte sources with ESLint.
lint:
  pnpm run lint

# Format the TypeScript/Svelte/JSON sources with Prettier.
format:
  pnpm run format

# Fail if any TypeScript/Svelte/JSON source is unformatted.
format-check:
  pnpm run format:check

# Format the Rust workspace (rustfmt, pinned by rust-toolchain.toml).
rust-format:
  cargo fmt --all

# Fail if any Rust file is unformatted.
rust-format-check:
  cargo fmt --all --check

# Clippy the workspace; fails on a panicking print macro in shipped Rust.
rust-lint:
  mkdir -p dist
  cargo clippy --workspace

# Lint hand-written Swift sources with swift-format (excludes generated bindings).
lint-swift:
  #!/usr/bin/env bash
  set -euo pipefail
  if [ "$(uname -s)" != "Darwin" ] || ! xcrun --find swift-format >/dev/null 2>&1; then
    echo "==> swift-format is unavailable on this host ($(uname -s)) — skipping Swift lint"
    exit 0
  fi
  find apps/ios/Sources apps/ios/Tests apps/ios/UITests \
    -name '*.swift' \
    -not -path '*/Generated/*' \
    -not -path '*/GeneratedContracts/*' \
    -not -path '*/GeneratedLocalization/*' \
    -print0 \
    | xargs -0 xcrun swift-format lint --strict --configuration apps/ios/.swift-format

# Fail fast in a fresh worktree instead of dying deep inside toolbar-spec-check.
_require-node-modules:
  @[ -d node_modules ] || { echo "No node_modules in this worktree — run: just install" >&2; exit 1; }

# Link installed third-party skills into .claude/skills/, including lock-matched sibling worktrees.
skills-link:
  @node scripts/skills-link.mjs

# Restore the former vendored Swift references from a pinned repository snapshot.
# Optional, per-worktree, and refuses to overwrite any installed skill or link.
skills-swift:
  #!/usr/bin/env bash
  set -euo pipefail
  snapshot=3b1c43c139181b91b7384b478b5edec454b80190
  skills=(swiftui-expert-skill swift-concurrency-pro swift-testing-pro)
  git cat-file -e "$snapshot^{commit}"
  for skill in "${skills[@]}"; do
    for destination in ".agents/skills/$skill" ".claude/skills/$skill"; do
      if [[ -e "$destination" || -L "$destination" ]]; then
        echo "Already present: $destination; leaving installed skills unchanged." >&2
        exit 1
      fi
    done
  done
  mkdir -p .agents/skills .claude/skills
  staging=$(mktemp -d .agents/swift-install.XXXXXX)
  trap 'rm -rf "$staging"' EXIT
  git archive "$snapshot" "${skills[@]/#/.claude/skills/}" | tar -xf - --strip-components=2 -C "$staging"
  for skill in "${skills[@]}"; do
    test -f "$staging/$skill/SKILL.md"
  done
  for skill in "${skills[@]}"; do
    mv "$staging/$skill" ".agents/skills/$skill"
    ln -s "../../.agents/skills/$skill" ".claude/skills/$skill"
  done

# Remove native build artifacts (Xcode DerivedData + Gradle output + web dist) to reclaim disk.
clean:
  rm -rf dist
  rm -rf apps/ios/.build apps/ios/.build-device apps/ios/.build-device-release
  rm -rf apps/android/app/build apps/android/build

# Three independent fail-fast guards for the same "no node_modules" papercut; see
# docs/agents/justfile-notes.md. This one also fails when a pnpm patchedDependencies
# patch is not applied in the installed copy (RC-69); `just install` runs it afterwards.
check-node-modules:
  @node scripts/check-node-modules.mjs

# Fail before tests/builds when the active Node differs from the pinned .nvmrc.
check-node-version:
  @node scripts/check-node-version.mjs

_require-install:
  @[ -d node_modules ] || { echo 'node_modules is missing in this worktree — run: just install' >&2; exit 1; }
