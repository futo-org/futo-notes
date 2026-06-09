#!/usr/bin/env bash
# Build & run the FUTO Notes NATIVE iOS spike on a CONNECTED PHYSICAL iPhone.
#
# Same app as run.sh (simulator), but a physical device requires code signing.
# Reuses the Apple Developer team the Tauri app signs under (auto-detected from
# apps/tauri/src-tauri/gen/apple/project.yml); override with FUTO_DEV_TEAM.
#
# Usage:
#   apps/ios/run-device.sh              # auto-detect device + team
#   FUTO_DEV_TEAM=XXXXXXXXXX apps/ios/run-device.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

APP_DIR="apps/ios"
DERIVED="$APP_DIR/.build-device"
# Debug builds use the dev bundle id (com.futo.notes.native.dev) + a separate
# data root + dev keychain so a dev install can never overwrite the production
# app or its notes/creds. The actual id is read back from the built bundle
# below (see project.yml dev config); this is only the fallback.
BUNDLE_ID="com.futo.notes.native.dev"

# ── Detect the connected physical device (CoreDevice UUID) ──
DEVFILE=$(mktemp /tmp/futo-devices.XXXXXX.json)
xcrun devicectl list devices --json-output "$DEVFILE" >/dev/null 2>&1 || true
UDID=$(python3 -c "
import json,sys
try: d=json.load(open('$DEVFILE'))
except Exception: sys.exit(0)
for x in d.get('result',{}).get('devices',[]):
    if x.get('connectionProperties',{}).get('transportType'):
        print(x.get('identifier','')); break
")
rm -f "$DEVFILE"
if [ -z "$UDID" ]; then
  echo "No connected iPhone found. Plug one in (and trust this Mac), then retry." >&2
  exit 1
fi
echo "==> Device: $UDID"

# ── Signing team ──
TEAM="${FUTO_DEV_TEAM:-}"
if [ -z "$TEAM" ]; then
  TEAM=$(grep -m1 'DEVELOPMENT_TEAM:' apps/tauri/src-tauri/gen/apple/project.yml 2>/dev/null | awk '{print $2}')
fi
if [ -z "$TEAM" ]; then
  echo "Could not determine a signing team. Set FUTO_DEV_TEAM=<10-char team id>." >&2
  exit 1
fi
echo "==> Signing team: $TEAM"

echo "==> JS deps"
[ -d node_modules ] || pnpm install

echo "==> Building Rust note + sync core (UniFFI) -> FutoNotesFfi.xcframework"
bash "$APP_DIR/build-rust-ios.sh"

echo "==> Building embedded editor bundle (single self-contained editor.html)"
node_modules/.bin/vite build --config vite.editor.config.ts

echo "==> Generating Xcode project (xcodegen)"
( cd "$APP_DIR" && xcodegen generate )

echo "==> Building signed app for device"
xcodebuild -project "$APP_DIR/FutoNotesNative.xcodeproj" \
  -scheme FutoNotesNative -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGNING_REQUIRED=YES \
  CODE_SIGN_IDENTITY="Apple Development" \
  -allowProvisioningUpdates \
  build | tail -3

APP=$(find "$DERIVED/Build/Products/Debug-iphoneos" -maxdepth 1 -name "*.app" | head -1)
if [ -z "$APP" ]; then echo "Build produced no .app" >&2; exit 1; fi

# Read the real bundle id from the built app so install/launch always match the
# active config (dev for Debug, prod for a future Release build).
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist" 2>/dev/null \
  || echo "$BUNDLE_ID")

echo "==> Installing $APP"
xcrun devicectl device install app --device "$UDID" "$APP"
echo "==> Launching $BUNDLE_ID"
xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID"
echo "==> Done. FUTO Notes Native is running on your iPhone."
