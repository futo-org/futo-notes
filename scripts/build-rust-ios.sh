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

# Rust's aarch64-apple-ios target defaults to a 10.0 minimum, but C objects
# built by cc-rs deps (zstd-sys via tantivy in futo-notes-search) reference
# ___chkstk_darwin, which the 10.0 libSystem stubs lack. Pin the deployment
# target to match the app's floor so device links succeed.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-14.0}"

APP="apps/ios"
GEN="$APP/Sources/Generated"
XCF="$APP/FutoNotesFfi.xcframework"
HEADERS="$ROOT/target/uniffi-headers"

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
  --library target/debug/libfuto_notes_ffi.dylib \
  --language swift \
  --out-dir "$GEN"

echo "==> Assembling module headers"
rm -rf "$HEADERS"; mkdir -p "$HEADERS"
cp "$GEN/futo_notes_ffiFFI.h" "$HEADERS/"
cp "$GEN/futo_notes_ffiFFI.modulemap" "$HEADERS/module.modulemap"
rm -f "$GEN/futo_notes_ffiFFI.h" "$GEN/futo_notes_ffiFFI.modulemap"

echo "==> Creating $XCF"
rm -rf "$XCF"
SIM_UNIVERSAL="$ROOT/target/universal-apple-ios-sim"
rm -rf "$SIM_UNIVERSAL"
mkdir -p "$SIM_UNIVERSAL"
lipo -create \
  target/aarch64-apple-ios-sim/$OUT_DIR/libfuto_notes_ffi.a \
  target/x86_64-apple-ios/$OUT_DIR/libfuto_notes_ffi.a \
  -output "$SIM_UNIVERSAL/libfuto_notes_ffi.a"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/$OUT_DIR/libfuto_notes_ffi.a -headers "$HEADERS" \
  -library "$SIM_UNIVERSAL/libfuto_notes_ffi.a" -headers "$HEADERS" \
  -output "$XCF"

echo "==> Done: $XCF and $GEN/futo_notes_ffi.swift"
