#!/usr/bin/env bash
# Build & run the FUTO Notes NATIVE Android app on a connected device/emulator.
#
# A from-scratch native Compose app that reuses the SAME web markdown editor
# (editor.html) as an embedded WebView and the SAME Rust core (futo-notes-ffi)
# as iOS. It does NOT use Tauri.
#
# Requires: Android SDK (ANDROID_HOME), NDK (ANDROID_NDK_HOME), `cargo install
# cargo-ndk`, the android rust targets, and a Gradle wrapper or system gradle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> JS deps"
[ -d node_modules ] || pnpm install

echo "==> Building Rust core (UniFFI) -> jniLibs/<abi>/libfuto_notes_ffi.so + Kotlin bindings"
bash scripts/build-rust-android.sh

echo "==> Building the SAME embedded editor bundle (single self-contained editor.html)"
node_modules/.bin/vite build --config vite.editor.config.ts
# Stage editor.html into the app's assets (same artifact iOS bundles).
mkdir -p apps/android/app/src/main/assets
cp apps/ios/Resources/editor.html apps/android/app/src/main/assets/editor.html

echo "==> Building + installing the app"
cd apps/android
if [ -x ./gradlew ]; then GRADLE=./gradlew; else GRADLE=gradle; fi
"$GRADLE" :app:installDebug

echo "==> Launching"
# `am start -n` rather than monkey: monkey exits 251 without launching on
# some emulators (observed on API 36 images).
adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity
echo "==> Done."
