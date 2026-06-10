#!/usr/bin/env bash
# Build futo-notes-ffi for iOS (device + simulator), generate the UniFFI Swift
# bindings, and assemble FutoNotesFfi.xcframework that the SwiftUI app links.
#
# futo-notes-ffi is the single FFI facade (note domain + sync). The SAME crate
# is built for Android by scripts/build-rust-android.sh.
#
# NOTE: built with the DEV profile on purpose — the workspace release profile
# uses panic="abort", which breaks UniFFI's panic catching.
set -euo pipefail

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
cargo build -p futo-notes-ffi --target aarch64-apple-ios

echo "==> Building futo-notes-ffi for simulator (aarch64-apple-ios-sim)"
cargo build -p futo-notes-ffi --target aarch64-apple-ios-sim

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
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/debug/libfuto_notes_ffi.a -headers "$HEADERS" \
  -library target/aarch64-apple-ios-sim/debug/libfuto_notes_ffi.a -headers "$HEADERS" \
  -output "$XCF"

echo "==> Done: $XCF and $GEN/futo_notes_ffi.swift"
