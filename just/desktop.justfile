# Desktop (Tauri) dev, test builds, and local .deb/.rpm installs. Imported by the root justfile.

# ── Desktop (Tauri) ──

# Desktop dev (Wayland, Vite port 5200+slot per worktree — scripts/lib/slot.mjs); `--fake-update[=X.Y.Z]` simulates an update banner.
tauri-dev *args:
  node scripts/tauri-dev.mjs "$@"

# Run an owned desktop stack under a private Linux compositor (verify frame delivery separately).
desktop-headless +args:
  bash scripts/run-under-virtual-kwin.sh "$@"

# Build the desktop AppImage/bundle for this platform.
tauri-build:
  pnpm run build
  # NO_STRIP: linuxdeploy's strip can't read newer binutils' AppImages locally; see justfile-notes.md.
  cd apps/tauri && NO_STRIP=true cargo tauri build

# Read the desktop instance journal (JSONL); native shells don't journal yet.
journal *args:
  @node scripts/journal.mjs "$@"

# Desktop smoke test (tests/AGENTS.md).
test-desktop-smoke:
  node tests/desktop-smoke.mjs


# Embedded debug app with test hooks; always build current web and Rust sources.
build-desktop-test:
  bash scripts/dev-env.sh node scripts/setup-worktree.mjs desktop --check
  VITE_INCLUDE_TEST_HOOKS=true just build
  # cargo clean -p so the build re-runs and re-embeds dist/ with the test
  # hooks: a futo-notes-tauri crate cached from a build without
  # VITE_INCLUDE_TEST_HOOKS can otherwise re-link a hooks-free binary. This
  # guard lived in the CI job script; it belongs here so every rebuild —
  # local or CI — gets it, and CI doesn't pay for a second identical build.
  cd apps/tauri && cargo clean -p futo-notes-tauri
  cargo build -p futo-notes-tauri

# Complete user journeys with a synthetic vault and real process restarts.
test-desktop-journeys: build-desktop-test
  node tests/desktop-journeys.mjs

# Window close with the webview's JS thread stalled (RC-37): the giant-note open must not trap the
# window, and a stall with an unsaved edit in it must not lose the edit. Linux: it asks a headless
# KWin to close the window. Not in CI: the desktop jobs run xvfb-run with no window manager.
test-desktop-close-deadline:
  bash scripts/run-under-virtual-kwin.sh bash -c 'just build-desktop-test && node tests/desktop-close-deadline.mjs'

# A lone UTF-16 surrogate in a note (RC-48): the save settles, the file holds U+FFFD, the note can be
# left. Linux, under a private compositor (WebKitGTK is the engine that never answered). Not in CI.
test-desktop-lone-surrogate:
  bash scripts/run-under-virtual-kwin.sh bash -c 'just build-desktop-test && node tests/desktop-lone-surrogate.mjs'

# Build .deb from current repo state and install it.
deploy-deb:
  #!/usr/bin/env bash
  set -euo pipefail
  BUNDLE_DIR="target/release/bundle/deb"
  # Version = latest git tag + commit distance.
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
  COMMITS_SINCE=$(git rev-list "${LATEST_TAG}..HEAD" --count)
  BASE_VER="${LATEST_TAG#v}"
  if [ "$COMMITS_SINCE" -gt 0 ]; then
    VERSION="${BASE_VER}-dev.${COMMITS_SINCE}"
  else
    VERSION="${BASE_VER}"
  fi
  echo "Version: ${VERSION}"
  VERSION_CONFIG_DIR=$(mktemp -d)
  VERSION_CONFIG="$VERSION_CONFIG_DIR/version.json"
  printf '{"version":"%s"}\n' "$VERSION" > "$VERSION_CONFIG"
  trap 'rm -f "$VERSION_CONFIG"; rmdir "$VERSION_CONFIG_DIR" 2>/dev/null || true' EXIT
  rm -rf "$BUNDLE_DIR"
  echo "Building .deb package..."
  (cd apps/tauri && cargo tauri build --bundles deb --config "$VERSION_CONFIG")
  DEB=$(ls -t "${BUNDLE_DIR}"/*.deb | head -1)
  # Single-checkout install: stops every FUTO Notes on the machine before
  # overwriting /usr/bin. NOT a QA-cleanup template — see justfile-notes.md.
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${DEB}..."
  sudo dpkg -i "$DEB"
  echo "Done. Installed FUTO Notes ${VERSION}."

# Build .rpm from current repo state and install it.
deploy-rpm:
  #!/usr/bin/env bash
  set -euo pipefail
  BUNDLE_DIR="target/release/bundle/rpm"
  # Version = latest git tag + commit distance.
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
  COMMITS_SINCE=$(git rev-list "${LATEST_TAG}..HEAD" --count)
  BASE_VER="${LATEST_TAG#v}"
  if [ "$COMMITS_SINCE" -gt 0 ]; then
    VERSION="${BASE_VER}-dev.${COMMITS_SINCE}"
  else
    VERSION="${BASE_VER}"
  fi
  echo "Version: ${VERSION}"
  VERSION_CONFIG_DIR=$(mktemp -d)
  VERSION_CONFIG="$VERSION_CONFIG_DIR/version.json"
  printf '{"version":"%s"}\n' "$VERSION" > "$VERSION_CONFIG"
  trap 'rm -f "$VERSION_CONFIG"; rmdir "$VERSION_CONFIG_DIR" 2>/dev/null || true' EXIT
  rm -rf "$BUNDLE_DIR"
  echo "Building .rpm package..."
  (cd apps/tauri && cargo tauri build --bundles rpm --config "$VERSION_CONFIG")
  RPM=$(ls -t "${BUNDLE_DIR}"/*.rpm | head -1)
  # Single-checkout install: stops every FUTO Notes on the machine before
  # overwriting /usr/bin. NOT a QA-cleanup template — see justfile-notes.md.
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${RPM}..."
  # rpm -U --force, not dnf reinstall (silently no-ops on a version mismatch); justfile-notes.md.
  if rpm -q futo-notes >/dev/null 2>&1; then
    sudo rpm -Uvh --force "$RPM"
  else
    sudo dnf install -y "$RPM"
  fi
  # Assert by sha256 against the package's own digest, not target/release/ (bundler strips it).
  EXPECTED_SHA=$(rpm -qp --dump "$RPM" 2>/dev/null | awk '$1 == "/usr/bin/futo-notes-tauri" { print $4 }')
  ACTUAL_SHA=$(sha256sum /usr/bin/futo-notes-tauri 2>/dev/null | cut -d' ' -f1)
  if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "" >&2
    echo "INSTALL FAILED: /usr/bin/futo-notes-tauri is NOT the binary just built." >&2
    echo "  expected sha256 (in package): ${EXPECTED_SHA:-<no /usr/bin/futo-notes-tauri in package>}" >&2
    echo "  actual   sha256 (on disk):    ${ACTUAL_SHA:-<file missing>}" >&2
    rpm -q --qf '  rpm db has: %{NAME}-%{VERSION}-%{RELEASE}, installed %{INSTALLTIME:date}\n' futo-notes >&2 || true
    echo "  Nothing was installed — do not test against this binary." >&2
    exit 1
  fi
  echo "Done. Installed FUTO Notes ${VERSION} (verified on disk)."
