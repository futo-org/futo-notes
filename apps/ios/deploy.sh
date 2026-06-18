#!/usr/bin/env bash
# Build a RELEASE native build and install it on a connected physical iPhone
# (production bundle id com.futo.notes). This is the native counterpart of the
# retired Tauri `deploy-ios`; for a DEBUG device install use run-device.sh
# (`just ios-native-device`), and for the simulator use run.sh (`just ios-native`).
#
# Reuses the Apple Developer team the Tauri app signs under (auto-detected);
# override with FUTO_DEV_TEAM=<10-char team id>.
#
# Usage:
#   apps/ios/deploy.sh
#   FUTO_DEV_TEAM=XXXXXXXXXX apps/ios/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

APP_DIR="apps/ios"
DERIVED="$APP_DIR/.build-device-release"

# ── Connected device (shared detection with run-device.sh) ──
UDID=$(node scripts/ios-device-id.mjs)
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

echo "==> Building signed RELEASE app for device"
xcodebuild -project "$APP_DIR/FutoNotesNative.xcodeproj" \
  -scheme FutoNotesNative -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGNING_REQUIRED=YES \
  CODE_SIGN_IDENTITY="Apple Development" \
  -allowProvisioningUpdates \
  build | tail -3

APP=$(find "$DERIVED/Build/Products/Release-iphoneos" -maxdepth 1 -name "*.app" | head -1)
if [ -z "$APP" ]; then echo "Build produced no .app" >&2; exit 1; fi

# Read the real bundle id from the built app (prod for Release).
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist" 2>/dev/null \
  || echo "com.futo.notes")

echo "==> Installing $APP ($BUNDLE_ID)"
xcrun devicectl device install app --device "$UDID" "$APP"
echo "==> Launching $BUNDLE_ID"
xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID"
echo "==> Done. FUTO Notes (Release) is running on your iPhone."
