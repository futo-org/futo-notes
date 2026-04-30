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
  node scripts/fetch-ort-linux.mjs
  node scripts/tauri-dev.mjs

tauri-prod:
  pnpm run build
  node scripts/fetch-ort-linux.mjs
  cd apps/tauri && WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev --config src-tauri/tauri.prod.conf.json

tauri-build:
  pnpm run build
  node scripts/fetch-ort-linux.mjs
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
  #!/usr/bin/env bash
  set -euo pipefail
  # Prefer a connected physical iPhone; fall back to a booted simulator.
  # Devices need the Mac's LAN IP for the dev server (127.0.0.1 isn't reachable
  # from the device); simulators reach 127.0.0.1 directly and skip code signing.
  DEVFILE=$(mktemp /tmp/devices.XXXXXX.json)
  xcrun devicectl list devices --json-output "$DEVFILE" >/dev/null 2>&1 || true
  PHYSICAL=$(python3 -c "
  import json, sys
  try:
      data = json.load(open('$DEVFILE'))
  except Exception:
      sys.exit(0)
  for d in data.get('result', {}).get('devices', []):
      conn = d.get('connectionProperties', {})
      if conn.get('transportType'):
          name = d.get('deviceProperties', {}).get('name', '')
          print(name)
          break
  ")
  rm -f "$DEVFILE"
  if [ -n "${PHYSICAL}" ]; then
    HOST=$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || true)
    if [ -z "${HOST}" ]; then
      echo "Error: physical device '${PHYSICAL}' is connected but couldn't determine Mac's LAN IP from en0/en1. Is Wi-Fi on?"
      exit 1
    fi
    echo "iOS dev: physical device '${PHYSICAL}' via ${HOST}"
    cd apps/tauri && TAURI_DEV_HOST="${HOST}" cargo tauri ios dev "${PHYSICAL}" --host "${HOST}" --config src-tauri/tauri.ios.conf.json --config src-tauri/tauri.ios.dev.conf.json
  else
    SIM=$(xcrun simctl list devices booted | awk -F'[()]' '/Booted/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print $1; exit }')
    if [ -z "${SIM}" ]; then
      echo "No booted iOS simulator. Boot one with: open -a Simulator"
      exit 1
    fi
    echo "iOS dev: simulator '${SIM}'"
    cd apps/tauri && cargo tauri ios dev "${SIM}" --config src-tauri/tauri.ios.conf.json --config src-tauri/tauri.ios.dev.conf.json
  fi

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

test-cross-platform-android:
  pnpm -w run test:cross-platform:android

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

# Factory: compare our editor to Obsidian's, scenario by scenario.
# See factory/AGENTS.md.
factory-judge *args:
  pnpm exec tsx factory/judge/run.ts --no-moves {{args}}

factory-judge-headed *args:
  pnpm exec tsx factory/judge/run.ts --no-moves --headed {{args}}

# Boot a long-running judge: Obsidian + chromium stay up, listening on
# factory/captures/daemon.sock. Use `factory-run`, `factory-watch`, and
# `factory-down` to drive it. Foreground process — Ctrl-C tears down.
factory-up *args:
  pnpm exec tsx factory/judge/run.ts daemon {{args}}

# Send a one-shot run to the daemon and stream divergences as they
# happen. Defaults to --no-moves like factory-judge.
factory-run *args:
  pnpm exec tsx factory/judge/run.ts run --no-moves {{args}}

# Re-run on every save of editor source files. Talks to the running
# daemon and reloads the futo-notes page before each run so HMR drift
# can't lie to you.
factory-watch *args:
  pnpm exec tsx factory/judge/run.ts watch --no-moves {{args}}

factory-down:
  pnpm exec tsx factory/judge/run.ts down

# Phase-1 visual oracle: inject a neutral theme into both editors,
# screenshot every scenario in the curated visual set, run a pixel
# diff, and emit factory/captures/visual-report.html. Pair with
# `just factory-up` (daemon must be running). After the run, ask
# Claude Code to "review the visual report" for an LLM-judge pass.
factory-visual *args:
  pnpm exec tsx factory/judge/run.ts run --no-moves --visual-only {{args}}

factory-summary:
  @node -e "const r = require('./factory/captures/last-run.json'); \
    console.log(JSON.stringify(r.summary, null, 2)); \
    const fail = r.reports.filter(x => x.divergences.length).sort((a,b) => b.divergences.length - a.divergences.length); \
    console.log('\\nWorst scenarios:'); \
    for (const x of fail.slice(0, 15)) console.log(' ', String(x.divergences.length).padStart(3), x.name);"

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
  node scripts/fetch-ort-linux.mjs >/dev/null
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
  echo "Done. Installed FUTO Notes ${VERSION}."

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
  node scripts/fetch-ort-linux.mjs >/dev/null
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
  echo "Done. Installed FUTO Notes ${VERSION}."

# Build iOS .ipa from current repo state and install on connected iPhone
deploy-ios:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  INFO_PLIST="apps/tauri/src-tauri/gen/apple/futo-notes-tauri_iOS/Info.plist"
  IPA="apps/tauri/src-tauri/gen/apple/build/arm64/FUTO Notes.ipa"
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
  echo "Done. Installed FUTO Notes ${VERSION} on iOS device."
