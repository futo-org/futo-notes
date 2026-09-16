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

# Refuse in ~2s — before the 10-25 minute Rust build — when this machine
# cannot run Gradle (no JDK 21 discoverable for Gradle's daemon-JVM pin, or a
# missing SDK location). Shared with the justfile recipes that call gradlew:
# scripts/android-env.sh.
source scripts/android-env.sh

# Distribution flavor (apps/android/app/build.gradle.kts). `direct` — what
# GitLab/Obtainium/F-Droid users install — is the dev-loop default; `play`
# builds the Google Play flavor from the same sources. Both carry the same
# applicationId, so whichever is installed replaces the other in place.
FLAVOR="${FUTO_ANDROID_FLAVOR:-direct}"
case "$FLAVOR" in
  direct) VARIANT=DirectDebug ;;
  play) VARIANT=PlayDebug ;;
  *)
    echo "FUTO_ANDROID_FLAVOR must be 'direct' or 'play' (got '$FLAVOR')" >&2
    exit 1
    ;;
esac

echo "==> JS deps"
[ -d node_modules ] || pnpm install

# hosted_server() only honours FUTO_HOSTED_SERVER in a build with
# debug_assertions on, and the default release-ffi profile inherits release,
# where it is compiled out — so without this, setting FUTO_HOSTED_SERVER here
# would silently do nothing and the app would still probe the real service.
# Not unconditional: switching profiles slows the normal dev loop.
if [ -n "${FUTO_HOSTED_SERVER:-}" ]; then
  export FUTO_ANDROID_FFI_PROFILE="${FUTO_ANDROID_FFI_PROFILE:-dev}"
  echo "==> FUTO_HOSTED_SERVER set -> using the '$FUTO_ANDROID_FFI_PROFILE' FFI profile so the override is honoured"
fi

echo "==> Building Rust core (UniFFI) -> jniLibs/<abi>/libfuto_notes_ffi.so + Kotlin bindings"
bash scripts/build-rust-android.sh

echo "==> Building the SAME embedded editor bundle (single self-contained editor.html)"
node_modules/.bin/vite build --config vite.editor.config.ts
# Stage editor.html into the app's assets (same artifact iOS bundles).
mkdir -p apps/android/app/src/main/assets
cp apps/ios/Resources/editor.html apps/android/app/src/main/assets/editor.html

echo "==> Building + installing the app ($FLAVOR flavor)"
cd apps/android
if [ -x ./gradlew ]; then GRADLE=./gradlew; else GRADLE=gradle; fi
"$GRADLE" ":app:install${VARIANT}"

echo "==> Launching"
# `am start -n` rather than monkey: monkey exits 251 without launching on
# some emulators (observed on API 36 images). The --es extra carries
# FUTO_HOSTED_SERVER across the process boundary (an Android app inherits no
# environment from the shell that launched it) — see DebugHostedServer.kt and
# scripts/qa.mjs's "point a debug app at it" line.
if [ -n "${FUTO_HOSTED_SERVER:-}" ]; then
  adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity \
    --es futo_hosted_server "$FUTO_HOSTED_SERVER"
else
  adb shell am start -n com.futo.notes.dev/com.futo.notes.MainActivity
fi
echo "==> Done."
