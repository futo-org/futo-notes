#!/usr/bin/env bash
# Build futo-notes-ffi for Android (all ABIs), generate the UniFFI Kotlin
# bindings, and stage the per-ABI .so into apps/android's jniLibs.
#
# Requires: ANDROID_NDK_HOME + `cargo install cargo-ndk` + the android rust
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

# ── Early environment checks with actionable errors ──────────────────────
# ANDROID_NDK_HOME is often not exported even when the NDK is installed —
# fall back to the newest NDK under the SDK before giving up.
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "${ANDROID_NDK_HOME}" ]]; then
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
  NEWEST_NDK=$(ls -1 "$SDK/ndk" 2>/dev/null | sort -V | tail -1)
  if [[ -n "$NEWEST_NDK" && -d "$SDK/ndk/$NEWEST_NDK" ]]; then
    export ANDROID_NDK_HOME="$SDK/ndk/$NEWEST_NDK"
    echo "==> ANDROID_NDK_HOME not set; using detected NDK: $ANDROID_NDK_HOME"
  fi
fi
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "${ANDROID_NDK_HOME}" ]]; then
  echo "ERROR: ANDROID_NDK_HOME is unset or not a directory." >&2
  echo "  Install the NDK via Android Studio (SDK Manager → NDK) and export e.g.:" >&2
  echo "  export ANDROID_NDK_HOME=\"\$HOME/Library/Android/sdk/ndk/<version>\"" >&2
  exit 1
fi
if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "ERROR: cargo-ndk not found. Install it:  cargo install cargo-ndk" >&2
  exit 1
fi

APP="apps/android"
JNI="$APP/app/src/main/jniLibs"
KOTLIN_OUT="$APP/app/src/main/java"

# ABIs: arm64 (modern devices), armv7 (older), x86_64 (emulator). i686 is rarely
# needed; add "x86" here if you target 32-bit emulators.
ABIS="${ABIS:-arm64-v8a,armeabi-v7a,x86_64}"
PROFILE="${FUTO_ANDROID_FFI_PROFILE:-release-ffi}"

echo "==> Building futo-notes-ffi for Android ABIs: $ABIS (profile: $PROFILE)"
cargo ndk --platform 24 --target "$ABIS" --output-dir "$JNI" \
  build -p futo-notes-ffi --profile "$PROFILE"

echo "==> Building host lib (for binding generation metadata)"
cargo build -p futo-notes-ffi

# The host dylib lives under cargo's target dir, which CARGO_TARGET_DIR can
# relocate (e.g. to share one warm target/ across worktrees) — the binding
# generation then failed with 'failed to open file target/debug/…' after a
# successful build (pc_2439ab43fc9b).
TARGET_DIR="${CARGO_TARGET_DIR:-target}"

echo "==> Generating Kotlin bindings"
# Host dylib extension differs by OS: macOS .dylib, Linux .so.
# Honour a relocated cargo target dir: with CARGO_TARGET_DIR set, the build
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
