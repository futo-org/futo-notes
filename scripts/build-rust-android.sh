#!/usr/bin/env bash
# Build futo-notes-ffi for Android (all ABIs), generate the UniFFI Kotlin
# bindings, and stage the per-ABI .so into apps/android's jniLibs.
#
# futo-notes-ffi is the single FFI facade (note domain + sync) — the SAME crate
# iOS builds via scripts/build-rust-ios.sh.
#
# Requires: ANDROID_NDK_HOME + `cargo install cargo-ndk` + the android rust
# targets (`rustup target add aarch64-linux-android armv7-linux-androideabi
# x86_64-linux-android i686-linux-android`).
#
# Built with the `release-ffi` profile (Cargo.toml): optimized, `panic =
# "unwind"` (so UniFFI's catch_unwind still turns Rust panics into Kotlin
# exceptions instead of SIGABRT-ing the app — the plain `release` profile sets
# panic="abort" and can't be used). The profile keeps the symbol table (no
# strip); AGP's `debugSymbolLevel = "FULL"` extracts those symbols into the Play
# AAB for native crash/ANR symbolication and strips the .so that ships to
# devices, so on-device size stays ~10–25 MB/ABI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Early environment checks with actionable errors ──────────────────────
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

echo "==> Building futo-notes-ffi for Android ABIs: $ABIS (profile: release-ffi)"
# cargo-ndk maps the friendly ABI names to rust targets and drops the per-ABI
# .so straight into jniLibs/<abi>/libfuto_notes_ffi.so. --profile release-ffi:
# optimized, symbols retained, panic="unwind" (UniFFI panic-catching). AGP
# strips + extracts symbols at bundle time. See Cargo.toml.
cargo ndk --platform 24 --target "$ABIS" --output-dir "$JNI" \
  build -p futo-notes-ffi --profile release-ffi

echo "==> Building host lib (for binding generation metadata)"
cargo build -p futo-notes-ffi

echo "==> Generating Kotlin bindings"
# Host dylib extension differs by OS: macOS .dylib, Linux .so.
case "$(uname -s)" in
  Darwin) HOST_LIB="target/debug/libfuto_notes_ffi.dylib" ;;
  *)      HOST_LIB="target/debug/libfuto_notes_ffi.so" ;;
esac
rm -rf "$KOTLIN_OUT/uniffi"; mkdir -p "$KOTLIN_OUT"
cargo run -p futo-notes-ffi --bin uniffi-bindgen -- generate \
  --library "$HOST_LIB" \
  --language kotlin \
  --out-dir "$KOTLIN_OUT"

echo "==> Done."
echo "    .so files: $JNI/<abi>/libfuto_notes_ffi.so"
echo "    bindings:  $KOTLIN_OUT/uniffi/futo_notes_ffi/futo_notes_ffi.kt"
