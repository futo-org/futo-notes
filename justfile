default:
  @just --list --unsorted

alias i := install
alias td := tauri-dev
alias tp := tauri-prod
alias tb := tauri-build
alias ad := android-dev
alias id := ios-dev
alias b := build
alias t := test
alias tu := test-unit
alias ts := test-shared
alias l := lint
alias c := check
alias sd := server-dev
alias st := server-test
alias cl := cli
alias cs := cli-setup
alias cset := cli-settings
alias cst := cli-status
alias cu := cli-update
alias dd := deploy-deb
alias dr := deploy-rpm

install:
  pnpm install

preview:
  pnpm run preview

lint:
  pnpm run lint

tauri-dev:
  pnpm run tauri:dev

tauri-prod:
  pnpm run tauri:prod

tauri-build:
  pnpm run tauri:build

android-dev:
  pnpm run tauri:android:dev

android-offline:
  pnpm run tauri:android:dev:offline

android-build:
  pnpm run tauri:android:build

ios-dev:
  pnpm run tauri:ios:dev

ios-offline:
  pnpm run tauri:ios:dev:offline

ios-build:
  pnpm run tauri:ios:build

server-dev:
  pnpm run server:dev

server-test:
  pnpm run server:test

server-up:
  docker compose -f crates/stonefruit-server/docker-compose.yml up --build -d

server-down:
  docker compose -f crates/stonefruit-server/docker-compose.yml down

server-health:
  curl -sf http://localhost:3005/health

build:
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

test:
  pnpm run test:all

test-unit:
  pnpm run test:unit

test-shared:
  pnpm run test:shared

test-e2e:
  pnpm run test

test-markdown-spec:
  pnpm run test:markdown-spec

test-headed:
  pnpm run test:headed

test-ui:
  pnpm run test:ui

test-desktop-smoke:
  pnpm run test:desktop-smoke

test-cross-platform:
  cd apps/tauri && VITE_INCLUDE_TEST_HOOKS=true cargo tauri build --debug --no-bundle && cd ../..
  cd apps/tauri && VITE_INCLUDE_TEST_HOOKS=true cargo tauri android build --debug --apk --config src-tauri/tauri.android.offline.conf.json && cd ../..
  cargo build -p stonefruit-server
  pnpm run test:cross-platform
  pnpm run test:cross-platform:android

test-cross-platform-android:
  cd apps/tauri && VITE_INCLUDE_TEST_HOOKS=true cargo tauri android build --debug --apk --config src-tauri/tauri.android.offline.conf.json && cd ../..
  cargo build -p stonefruit-server
  pnpm run test:cross-platform:android

test-rust:
  pnpm run tauri:test:rust

check:
  pnpm run lint
  pnpm run test:all
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

ci:
  pnpm run ci

cli-build:
  cd apps/cli && make build

cli *args:
  cargo run -p stonefruit-cli -- {{args}}

cli-setup *args:
  mkdir -p .tmp
  tmpdir=$(mktemp -d .tmp/cli-setup.XXXXXX) && \
    port=3005 && \
    while lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; do \
      port=$((port + 1)); \
    done && \
    echo "Running CLI setup test in $tmpdir" && \
    echo "Using port $port" && \
    cd "$tmpdir" && \
    cargo run --manifest-path ../../apps/cli/Cargo.toml -- setup --port "$port" {{args}}

cli-settings *args:
  cargo run -p stonefruit-cli -- settings {{args}}

cli-status *args:
  cargo run -p stonefruit-cli -- status {{args}}

cli-update *args:
  cargo run -p stonefruit-cli -- update {{args}}

# Build .deb from current repo state and install it
deploy-deb:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  BUNDLE_DIR="target/release/bundle/deb"
  # Stamp version from latest git tag + commit distance
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
  COMMITS_SINCE=$(git rev-list "${LATEST_TAG}..HEAD" --count)
  BASE_VER="${LATEST_TAG#v}"
  if [ "$COMMITS_SINCE" -gt 0 ]; then
    VERSION="${BASE_VER}-dev.${COMMITS_SINCE}"
  else
    VERSION="${BASE_VER}"
  fi
  echo "Version: ${VERSION}"
  node -e "const fs=require('fs'),f='${CONF}',c=JSON.parse(fs.readFileSync(f));c.version='${VERSION}';fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"
  # Clean stale bundles so we never install an old one
  rm -rf "$BUNDLE_DIR"
  echo "Building .deb package..."
  cd apps/tauri && cargo tauri build --bundles deb
  cd ../..
  DEB=$(ls -t "${BUNDLE_DIR}"/*.deb | head -1)
  # Kill running instance (comm is truncated to 15 chars, so use -f)
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${DEB}..."
  sudo dpkg -i "$DEB"
  # Restore tauri.conf.json so git stays clean
  git checkout -- "$CONF"
  echo "Done. Installed Stonefruit ${VERSION}."

# Build .rpm from current repo state and install it
deploy-rpm:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  BUNDLE_DIR="target/release/bundle/rpm"
  # Stamp version from latest git tag + commit distance
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
  COMMITS_SINCE=$(git rev-list "${LATEST_TAG}..HEAD" --count)
  BASE_VER="${LATEST_TAG#v}"
  if [ "$COMMITS_SINCE" -gt 0 ]; then
    VERSION="${BASE_VER}-dev.${COMMITS_SINCE}"
  else
    VERSION="${BASE_VER}"
  fi
  echo "Version: ${VERSION}"
  node -e "const fs=require('fs'),f='${CONF}',c=JSON.parse(fs.readFileSync(f));c.version='${VERSION}';fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"
  # Clean stale bundles so we never install an old one
  rm -rf "$BUNDLE_DIR"
  echo "Building .rpm package..."
  cd apps/tauri && cargo tauri build --bundles rpm
  cd ../..
  RPM=$(ls -t "${BUNDLE_DIR}"/*.rpm | head -1)
  # Kill running instance (comm is truncated to 15 chars, so use -f)
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${RPM}..."
  sudo dnf install -y "$RPM" || sudo rpm -Uvh --force "$RPM"
  # Restore tauri.conf.json so git stays clean
  git checkout -- "$CONF"
  echo "Done. Installed Stonefruit ${VERSION}."

cli-build-all:
  cd apps/cli && make build-all

cli-test:
  cd apps/cli && make test

cli-clean:
  cd apps/cli && make clean
