#!/usr/bin/env bash
# Build futo-notes-ffi for iOS (device + simulator), generate the UniFFI Swift
# bindings, and assemble FutoNotesFfi.xcframework that the SwiftUI app links.
#
# Built with the `release-ffi` profile (Cargo.toml) by default: the workspace
# release profile uses panic="abort", which breaks UniFFI's panic catching.
# FUTO_IOS_FFI_PROFILE=dev skips LTO so this script reruns in ~10s instead of
# ~50s after a crate edit; apps/ios/run.sh and run-device.sh set it.
set -euo pipefail

PROFILE="${FUTO_IOS_FFI_PROFILE:-release-ffi}"
case "$PROFILE" in dev) OUT_DIR=debug ;; *) OUT_DIR="$PROFILE" ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The iOS build is macOS-only (xcrun, lipo, xcodebuild). On Linux it used to
# compile Rust for minutes and only then die inside cc-rs on the missing
# xcrun (pc_d48cfd0861aa) — refuse up front instead.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: iOS builds require macOS (xcrun/lipo/xcodebuild); this host is $(uname -s)." >&2
  exit 1
fi

# cargo relocates its target dir under CARGO_TARGET_DIR (e.g. one warm target/
# shared across worktrees); the hardcoded target/… paths below would then miss
# the freshly built artifacts (pc_2439ab43fc9b, Android sibling).
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"

# Rust's aarch64-apple-ios target defaults to a 10.0 minimum, but C objects
# built by cc-rs deps (zstd-sys via tantivy in futo-notes-search) reference
# ___chkstk_darwin, which the 10.0 libSystem stubs lack. Pin the deployment
# target to match the app's floor so device links succeed.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-14.0}"

APP="apps/ios"
GEN="$APP/Sources/Generated"
XCF="$APP/FutoNotesFfi.xcframework"
HEADERS="$TARGET_DIR/uniffi-headers"

echo "==> Building futo-notes-ffi for device (aarch64-apple-ios)"
cargo build -p futo-notes-ffi --target aarch64-apple-ios --profile "$PROFILE"

echo "==> Building futo-notes-ffi for simulator (aarch64-apple-ios-sim)"
cargo build -p futo-notes-ffi --target aarch64-apple-ios-sim --profile "$PROFILE"

echo "==> Building futo-notes-ffi for simulator (x86_64-apple-ios)"
cargo build -p futo-notes-ffi --target x86_64-apple-ios --profile "$PROFILE"

echo "==> Building host lib (for binding generation metadata)"
cargo build -p futo-notes-ffi

echo "==> Generating Swift bindings"
rm -rf "$GEN"; mkdir -p "$GEN"
cargo run -p futo-notes-ffi --bin uniffi-bindgen -- generate \
  --library "$TARGET_DIR/debug/libfuto_notes_ffi.dylib" \
  --language swift \
  --out-dir "$GEN"

echo "==> Assembling module headers"
rm -rf "$HEADERS"; mkdir -p "$HEADERS"
cp "$GEN/futo_notes_ffiFFI.h" "$HEADERS/"
cp "$GEN/futo_notes_ffiFFI.modulemap" "$HEADERS/module.modulemap"
rm -f "$GEN/futo_notes_ffiFFI.h" "$GEN/futo_notes_ffiFFI.modulemap"

echo "==> Creating $XCF"
rm -rf "$XCF"
SIM_UNIVERSAL="$TARGET_DIR/universal-apple-ios-sim"
rm -rf "$SIM_UNIVERSAL"
mkdir -p "$SIM_UNIVERSAL"
lipo -create \
  "$TARGET_DIR/aarch64-apple-ios-sim/$OUT_DIR/libfuto_notes_ffi.a" \
  "$TARGET_DIR/x86_64-apple-ios/$OUT_DIR/libfuto_notes_ffi.a" \
  -output "$SIM_UNIVERSAL/libfuto_notes_ffi.a"
xcodebuild -create-xcframework \
  -library "$TARGET_DIR/aarch64-apple-ios/$OUT_DIR/libfuto_notes_ffi.a" -headers "$HEADERS" \
  -library "$SIM_UNIVERSAL/libfuto_notes_ffi.a" -headers "$HEADERS" \
  -output "$XCF"

echo "==> Done: $XCF and $GEN/futo_notes_ffi.swift"
