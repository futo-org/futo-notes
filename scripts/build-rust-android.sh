#!/usr/bin/env bash
# Build futo-notes-ffi for Android (every shipped ABI, or $ABIS), generate the
# UniFFI Kotlin bindings, and stage the per-ABI .so into apps/android's jniLibs.
#
# Requires: the Gradle-pinned NDK (discovered under the SDK, or set via
# ANDROID_NDK_HOME) + `cargo install cargo-ndk` + the android rust
# targets (`rustup target add aarch64-linux-android armv7-linux-androideabi
# x86_64-linux-android i686-linux-android`).
#
# `release-ffi` preserves panic unwinding for UniFFI and keeps symbols for AGP
# to extract before stripping the device libraries.
#
# FUTO_ANDROID_FFI_PROFILE=dev builds the `dev` profile instead — the Android
# twin of build-rust-ios.sh's FUTO_IOS_FFI_PROFILE. It is the only way to reach
# the engine's own debug-only overrides from this shell, because they are gated
# on `debug_assertions`, which `release-ffi` inherits from `release` with off.
# `FUTO_HOSTED_SERVER` is the one that matters today: without a dev build the
# hosted wizard can only ever talk to the baked address. Never ship it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# FUTO_LICENSE_ENV=staging|production overrides which FUTOpay org the license
# crate verifies and buys against (default: the bundle id's `.dev` split).
# It is compiled in, so it must be set on THIS build; say so loudly.
if [[ -n "${FUTO_LICENSE_ENV:-}" ]]; then
  echo "==> FUTO_LICENSE_ENV=$FUTO_LICENSE_ENV — license org forced for this build (overrides the bundle id)"
fi

# ── Early environment checks with actionable errors ──────────────────────
# Use the same discovery and pin validation as setup; selecting the newest
# installed NDK can disagree with AGP and silently skip library stripping.
ANDROID_NDK_HOME="$(node "$ROOT/scripts/lib/android-toolchain.mjs")"
export ANDROID_NDK_HOME
echo "==> Using Android NDK: $ANDROID_NDK_HOME"
if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "ERROR: cargo-ndk not found. Install it:  cargo install cargo-ndk" >&2
  exit 1
fi

APP="apps/android"
JNI="$APP/app/src/main/jniLibs"
KOTLIN_OUT="$APP/app/src/main/java"

# ABIs: arm64 (current phones, Apple Silicon emulators), armv7 (older phones),
# x86_64 (Intel emulators, ChromeOS). The default is every ABI the app ships
# (`abiFilters` in app/build.gradle.kts), which releases and CI need.
# ABIS=device builds only the connected device's ABI — about a third of a cold
# build — and is what the dev recipes pass; adb honors ANDROID_SERIAL. With no
# single device to ask (none, or several and no ANDROID_SERIAL) it builds all.
ALL_ABIS="arm64-v8a,armeabi-v7a,x86_64"
ABIS="${ABIS:-$ALL_ABIS}"
if [[ "$ABIS" == device ]]; then
  if DEVICE_ABI="$(adb shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')" \
    && [[ -n "$DEVICE_ABI" ]]; then
    ABIS="$DEVICE_ABI"
  else
    echo "==> ABIS=device: no single device answered adb; building every ABI"
    ABIS="$ALL_ABIS"
  fi
fi
PROFILE="${FUTO_ANDROID_FFI_PROFILE:-release-ffi}"

# Start empty: a .so left from an earlier build for an ABI this run skips would
# still be packaged, so a device of that ABI would run old Rust. It now fails
# at library load instead — as does any install after a failed or stopped build.
rm -rf "$JNI"

echo "==> Building futo-notes-ffi for Android ABIs: $ABIS (profile: $PROFILE)"
cargo ndk --platform 24 --target "$ABIS" --output-dir "$JNI" \
  build -p futo-notes-ffi --profile "$PROFILE"

echo "==> Building host lib (for binding generation metadata)"
cargo build -p futo-notes-ffi

echo "==> Generating Kotlin bindings"
# Host dylib extension differs by OS: macOS .dylib, Linux .so.
# Honor a relocated cargo target dir: with CARGO_TARGET_DIR set, the build
# above lands there and a hardcoded target/ path finds nothing (pc_b0e9c9e5f9f8).
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
case "$(uname -s)" in
  Darwin) HOST_LIB="$TARGET_DIR/debug/libfuto_notes_ffi.dylib" ;;
  *)      HOST_LIB="$TARGET_DIR/debug/libfuto_notes_ffi.so" ;;
esac
rm -rf "$KOTLIN_OUT/uniffi"; mkdir -p "$KOTLIN_OUT"
cargo run -p futo-notes-ffi --bin uniffi-bindgen -- generate \
  --library "$HOST_LIB" \
  --language kotlin \
  --out-dir "$KOTLIN_OUT"

echo "==> Done."
echo "    .so files: $JNI/<abi>/libfuto_notes_ffi.so"
echo "    bindings:  $KOTLIN_OUT/uniffi/futo_notes_ffi/futo_notes_ffi.kt"
