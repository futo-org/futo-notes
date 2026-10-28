#!/usr/bin/env bash
# Build & run the FUTO Notes native iOS app on a booted simulator.
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
# Presence-only ([ -d node_modules ]) is not enough: a stale install loses the
# vite binary and used to die only AFTER the Rust build. One owner:
# scripts/editor-deps.sh.
bash scripts/editor-deps.sh

echo "==> Building Rust note + sync core (UniFFI) -> FutoNotesFfi.xcframework + Swift bindings"
FUTO_IOS_FFI_PROFILE="${FUTO_IOS_FFI_PROFILE:-dev}" bash scripts/build-rust-ios.sh

echo "==> Building embedded editor web bundle (single self-contained editor.html)"
# The shipped bundle plus the puppet inspector (src/app/puppet), with function
# names kept for its trace. Release scripts (deploy.sh) build it without.
VITE_INCLUDE_TEST_HOOKS=true node_modules/.bin/vite build --config vite.editor.config.ts

echo "==> Generating Xcode project (xcodegen)"
( cd apps/ios && xcodegen generate )

echo "==> Building app"
# Ad-hoc sign (CODE_SIGN_IDENTITY=-) so the Keychain works on the simulator
# (sync-password persistence for force-quit survival). The entitlements file is
# wired via project.yml (CODE_SIGN_ENTITLEMENTS). Unsigned builds get
# errSecMissingEntitlement (-34018) from the simulator keychain.
# Full output goes to a log file: quiet (last 3 lines) on success, the whole
# thing on failure — `build | tail -3` used to throw away the actual error
# (e.g. a codesign failure) and leave only "** BUILD FAILED **" + a file path.
BUILD_LOG="$(mktemp)"
trap 'rm -f "$BUILD_LOG"' EXIT
if xcodebuild -project apps/ios/FutoNotesNative.xcodeproj \
  -scheme FutoNotesNative -configuration Debug \
  -destination "id=$SIM" \
  -derivedDataPath apps/ios/.build \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="-" build \
  > "$BUILD_LOG" 2>&1; then
  tail -3 "$BUILD_LOG"
else
  echo "==> xcodebuild failed:" >&2
  cat "$BUILD_LOG" >&2
  exit 1
fi

APP=$(find apps/ios/.build/Build/Products/Debug-iphonesimulator \
  -maxdepth 1 -name "*.app" | head -1)
# Debug builds use the dev bundle id (com.futo.notes.dev) + a separate
# data root (Documents/fake-notes) so a dev install can never overwrite the
# production app or touch the user's real notes (see project.yml dev config).
# Read the actual id from the built bundle so this stays correct if the id moves.
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist" 2>/dev/null \
  || echo "com.futo.notes.dev")
echo "==> Installing $APP"
xcrun simctl install "$SIM" "$APP"
# The debug-only puppet listener (PuppetServer.swift) binds a slot-derived
# loopback port so parallel worktrees cannot drive each other's simulator.
# Simulator apps do not inherit this shell's environment; SIMCTL_CHILD_* is how
# simctl passes it in. Unset means no listener at all.
PUPPET_PORT=$(node "$ROOT/scripts/lib/slot.mjs" puppet)
# The listener's screen reader (PuppetScreenReader.swift) walks the app's accessibility
# tree, which iOS builds only while this simulator setting is on; with it off every
# read is empty. The app reads it at launch, so it is set first, on every launch: a new
# or erased simulator starts with it off.
xcrun simctl spawn "$SIM" defaults write com.apple.Accessibility ApplicationAccessibilityEnabled -bool true
SIMCTL_CHILD_FUTO_PUPPET_PORT="$PUPPET_PORT" xcrun simctl launch "$SIM" "$BUNDLE_ID"
echo "==> Launched $BUNDLE_ID (futo-puppet listener on 127.0.0.1:$PUPPET_PORT)"
