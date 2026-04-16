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
alias dd := deploy-deb
alias dr := deploy-rpm
alias di := deploy-ios

install:
  pnpm install

preview:
  pnpm run preview

lint:
  pnpm run lint

tauri-dev:
  node scripts/tauri-dev.mjs

tauri-prod:
  pnpm run build
  cd apps/tauri && WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev --config src-tauri/tauri.prod.conf.json

tauri-build:
  pnpm run build
  # NO_STRIP=true: linuxdeploy ships an old `strip` that can't read
  # .relr.dyn sections emitted by newer binutils (Fedora 39+, Arch, etc.),
  # which breaks AppImage bundling. CI runs on ubuntu:22.04 where stock
  # strip matches, so this is local-only noise.
  cd apps/tauri && NO_STRIP=true cargo tauri build

android-dev:
  cd apps/tauri && cargo tauri android dev --config src-tauri/tauri.android.dev-mode.conf.json

android-offline:
  #!/usr/bin/env bash
  set -euo pipefail
  pnpm run build
  cd apps/tauri
  cargo tauri android build --debug --apk --config src-tauri/tauri.android.offline.conf.json
  cd src-tauri/gen/android && ./gradlew app:installUniversalDebug
  adb shell monkey -p com.futo.notes -c android.intent.category.LAUNCHER 1

android-build:
  cd apps/tauri && cargo tauri android build

ios-dev:
  cd apps/tauri && cargo tauri ios dev --config src-tauri/tauri.ios.dev.conf.json

ios-offline:
  #!/usr/bin/env bash
  set -euo pipefail
  IPA_DIR="apps/tauri/src-tauri/gen/apple/build/arm64"
  pnpm run build
  node scripts/fetch-ort-ios.mjs >/dev/null
  # Clean stale IPAs so we always install the freshly built one
  rm -f "$IPA_DIR"/*.ipa
  cd apps/tauri
  cargo tauri ios build --debug --config src-tauri/tauri.ios.dev.conf.json
  cd ../..
  # Find the IPA (name depends on productName in the config)
  IPA=$(ls -t "$IPA_DIR"/*.ipa 2>/dev/null | head -1)
  if [ -z "$IPA" ]; then
    echo "Error: No IPA found in ${IPA_DIR}"
    exit 1
  fi
  DEVFILE=$(mktemp /tmp/devices.XXXXXX.json)
  xcrun devicectl list devices --json-output "$DEVFILE" >/dev/null 2>&1
  DEVICE=$(python3 -c "
  import json
  data = json.load(open('$DEVFILE'))
  devices = data.get('result', {}).get('devices', [])
  for d in devices:
      conn = d.get('connectionProperties', {})
      if conn.get('transportType'):
          print(d.get('identifier', ''))
          break
  ")
  rm -f "$DEVFILE"
  if [ -z "$DEVICE" ]; then
    echo "Error: No connected iOS device found."
    exit 1
  fi
  echo "Installing ${IPA} on device ${DEVICE}..."
  xcrun devicectl device install app --device "$DEVICE" "$IPA"
  echo "Launching..."
  xcrun devicectl device process launch --device "$DEVICE" com.futo.notes.dev

ios-build:
  cd apps/tauri && cargo tauri ios build

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

test-cross-platform:
  pnpm run test:cross-platform

test-markdown-spec:
  pnpm run test:markdown-spec

test-headed:
  pnpm run test:headed

test-ui:
  pnpm run test:ui

test-desktop-smoke:
  node tests/desktop-smoke.mjs

test-rust:
  mkdir -p dist
  cd apps/tauri/src-tauri && cargo test

check:
  pnpm run lint
  pnpm run test:all
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

ci:
  pnpm run ci

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

# Build iOS .ipa from current repo state and install on connected iPhone
deploy-ios:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  INFO_PLIST="apps/tauri/src-tauri/gen/apple/futo-notes-tauri_iOS/Info.plist"
  IPA="apps/tauri/src-tauri/gen/apple/build/arm64/Stonefruit.ipa"
  BUNDLE_ID="com.futo.notes"
  # Auto-detect connected device
  DEVFILE=$(mktemp /tmp/devices.XXXXXX.json)
  xcrun devicectl list devices --json-output "$DEVFILE" >/dev/null 2>&1
  DEVICE=$(python3 -c "
  import json
  data = json.load(open('$DEVFILE'))
  devices = data.get('result', {}).get('devices', [])
  for d in devices:
      conn = d.get('connectionProperties', {})
      if conn.get('transportType'):
          print(d.get('identifier', ''))
          break
  ")
  rm -f "$DEVFILE"
  if [ -z "$DEVICE" ]; then
    echo "Error: No connected iOS device found."
    exit 1
  fi
  echo "Device: ${DEVICE}"
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
  # Fetch ORT xcframework for iOS inference (cached after first run)
  node scripts/fetch-ort-ios.mjs >/dev/null
  # Clean stale build so we never install an old one
  rm -f "$IPA"
  echo "Building iOS .ipa..."
  cd apps/tauri && cargo tauri ios build
  cd ../..
  if [ ! -f "$IPA" ]; then
    echo "Error: IPA not found at ${IPA}"
    git checkout -- "$CONF"
    exit 1
  fi
  echo "Installing on device ${DEVICE}..."
  xcrun devicectl device install app --device "$DEVICE" "$IPA"
  echo "Launching..."
  xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID"
  # Restore stamped files so git stays clean
  git checkout -- "$CONF" "$INFO_PLIST"
  echo "Done. Installed Stonefruit ${VERSION} on iOS device."
