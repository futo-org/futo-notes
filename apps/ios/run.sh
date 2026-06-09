#!/usr/bin/env bash
# Build & run the FUTO Notes NATIVE iOS spike on a booted simulator.
#
# This is a from-scratch native SwiftUI app that reuses the existing web
# markdown editor as an embedded WKWebView. It does NOT use Tauri.
#
# Usage:
#   apps/ios/run.sh            # use the booted simulator
#   SIM=<udid> apps/ios/run.sh # target a specific simulator
set -euo pipefail

# repo root (two levels up from apps/ios/)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SIM="${SIM:-}"
if [ -z "$SIM" ]; then
  SIM=$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)).*Booted.*/\1/p' | head -1)
fi
if [ -z "$SIM" ]; then
  echo "No booted simulator found." >&2
  echo "Boot one, e.g.:  xcrun simctl boot 'iPhone 17 Pro' && open -a Simulator" >&2
  echo "Or pass one:     SIM=<udid> $0" >&2
  exit 1
fi
echo "==> Simulator: $SIM"

echo "==> JS deps"
[ -d node_modules ] || pnpm install

echo "==> Building Rust note + sync core (UniFFI) -> FutoNotesFfi.xcframework + Swift bindings"
bash apps/ios/build-rust-ios.sh

echo "==> Building embedded editor web bundle (single self-contained editor.html)"
node_modules/.bin/vite build --config vite.editor.config.ts

echo "==> Generating Xcode project (xcodegen)"
( cd apps/ios && xcodegen generate )

echo "==> Building app"
# Ad-hoc sign (CODE_SIGN_IDENTITY=-) so the Keychain works on the simulator
# (sync-password persistence for force-quit survival). The entitlements file is
# wired via project.yml (CODE_SIGN_ENTITLEMENTS). Unsigned builds get
# errSecMissingEntitlement (-34018) from the simulator keychain.
xcodebuild -project apps/ios/FutoNotesNative.xcodeproj \
  -scheme FutoNotesNative -configuration Debug \
  -destination "id=$SIM" \
  -derivedDataPath apps/ios/.build \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="-" build | tail -3

APP=$(find apps/ios/.build/Build/Products/Debug-iphonesimulator \
  -maxdepth 1 -name "*.app" | head -1)
# Debug builds use the dev bundle id (com.futo.notes.native.dev) + a separate
# data root (Documents/fake-notes) so a dev install can never overwrite the
# production app or touch the user's real notes (see project.yml dev config).
# Read the actual id from the built bundle so this stays correct if the id moves.
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist" 2>/dev/null \
  || echo "com.futo.notes.native.dev")
echo "==> Installing $APP"
xcrun simctl install "$SIM" "$APP"
xcrun simctl launch "$SIM" "$BUNDLE_ID"
echo "==> Launched $BUNDLE_ID"
