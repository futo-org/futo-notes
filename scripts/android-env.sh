# shellcheck shell=bash
# Shared Android build-environment guard, SOURCED (not executed) by every Gradle
# entry point: apps/android/run.sh and the just recipes that invoke ./gradlew.
# Source it from the repo root (all just recipes and run.sh are already there).
#
# Why this exists, and why the checks are FIRST in each entry point rather than
# wherever the failure used to surface:
#
#  1. Gradle 8.14.3's embedded Kotlin DSL cannot parse a two-digit JDK feature
#     version, so a machine whose `java` — or Android Studio's bundled JBR,
#     which moves when Studio updates — is JDK 25+ dies at Gradle startup with
#     the ENTIRE error being "IllegalArgumentException: 25.0.2". It reads like a
#     corrupt build file, not a JDK problem, and it lands at the very END of a
#     10-25 minute Rust/FFI build. Reported seven times: pc_f1dd7e1cadf5,
#     pc_c3ab8b92b2e9, pc_78b8d9284183, pc_1ea31dd4cdd1, pc_da1315ee13c1,
#     pc_7e042021f667, pc_eacf97823fc0.
#  2. A fresh worktree has no gitignored apps/android/local.properties, so
#     Gradle separately dies with "SDK location not found" — again only after
#     everything else succeeded (pc_5b9cbbcebdb0).
#
# Both are knowable in ~2 seconds, before any build work: check first, fail
# fast with a message that names the actual requirement (M15), the same
# early-check pattern scripts/build-rust-android.sh uses for cargo-ndk.

ANDROID_ENV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── JDK: Gradle cannot run on JDK 25+ ───────────────────────────────────────

# Print the feature version of the java Gradle would actually use, or nothing
# when there is none. JDK 8 reports "1.8.0_…", so the first number alone lies.
android_env_java_major() {
  local java_bin="${JAVA_HOME:-}"
  [[ -n "$java_bin" ]] && java_bin="$java_bin/bin/java"
  if [[ -z "$java_bin" || ! -x "$java_bin" ]]; then
    java_bin="$(command -v java 2>/dev/null || true)"
  fi
  [[ -z "$java_bin" ]] && return 0
  local version_line major
  version_line="$("$java_bin" -version 2>&1 | head -1)"
  major="$(printf '%s' "$version_line" | sed -n 's/.*version "\([0-9][0-9]*\)[."].*/\1/p')"
  if [[ "$major" == "1" ]]; then
    major="$(printf '%s' "$version_line" | sed -n 's/.*version "1\.\([0-9][0-9]*\).*/\1/p')"
  fi
  printf '%s' "$major"
}

# Print the home of an installed JDK 21 (the known-good Gradle version here) if
# one can be found, else nothing. Best-effort standard locations only.
android_env_resolve_jdk21() {
  local candidate
  if [[ "$(uname -s)" == "Darwin" ]]; then
    candidate="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
    if [[ -n "$candidate" && -x "$candidate/bin/java" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
    for candidate in \
      /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
      /opt/homebrew/Cellar/openjdk@21/*/libexec/openjdk.jdk/Contents/Home; do
      if [[ -x "$candidate/bin/java" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  else
    for candidate in /usr/lib/jvm/*21*; do
      if [[ -x "$candidate/bin/java" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  fi
}

# Deliberately does NOT export or alter JAVA_HOME (and never shells out to
# `/usr/libexec/java_home -v 21` to set one): Gradle's own daemon JVM is
# pinned by apps/android/gradle/gradle-daemon-jvm.properties (JDK 21), which
# makes Gradle auto-provision or auto-detect JDK 21 for the daemon regardless
# of the CALLING shell's `java`/`JAVA_HOME` — that pin is the single source of
# truth (see apps/android/AGENTS.md). Exporting JAVA_HOME here would fight
# that pin instead of trusting it, and would leak a stale JDK 21 into every
# OTHER tool this shell later runs. This check only warns loudly, ~2s in,
# before the 10-25 minute Rust/FFI build, if nothing looks like it could
# satisfy the pin — so the fix is still visible up front — but takes no action.
ANDROID_ENV_JAVA_MAJOR="$(android_env_java_major)"
if [[ -z "$ANDROID_ENV_JAVA_MAJOR" || "$ANDROID_ENV_JAVA_MAJOR" -gt 24 ]]; then
  ANDROID_ENV_JAVA_HOME="$(android_env_resolve_jdk21)"
  if [[ -n "$ANDROID_ENV_JAVA_HOME" ]]; then
    echo "==> this shell's default java (JDK ${ANDROID_ENV_JAVA_MAJOR:-missing}) cannot run Gradle directly; a JDK 21 is installed at $ANDROID_ENV_JAVA_HOME and Gradle's daemon-JVM pin (apps/android/gradle/gradle-daemon-jvm.properties) will use it automatically — not exporting JAVA_HOME."
  else
    echo "ERROR: no JDK 21 found for Gradle's pinned daemon JVM (this shell's java: ${ANDROID_ENV_JAVA_MAJOR:-none})." >&2
    echo "  Gradle 8.14.3's Kotlin DSL cannot parse a two-digit JDK feature" >&2
    echo "  version — JDK 25 dies at startup with just 'IllegalArgumentException: 25.0.2'." >&2
    echo "  Install JDK 21 (macOS: brew install openjdk@21) so Gradle's" >&2
    echo "  daemon-JVM pin (apps/android/gradle/gradle-daemon-jvm.properties) can find it." >&2
    echo "  Do NOT fix this by exporting JAVA_HOME — see apps/android/AGENTS.md." >&2
    return 1 2>/dev/null || exit 1
  fi
fi

# ── SDK location: fresh worktrees have no local.properties ───────────────────

if [[ ! -f "$ANDROID_ENV_ROOT/apps/android/local.properties" ]]; then
  ANDROID_ENV_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -z "$ANDROID_ENV_SDK" ]]; then
    case "$(uname -s)" in
      Darwin) [[ -d "$HOME/Library/Android/sdk" ]] && ANDROID_ENV_SDK="$HOME/Library/Android/sdk" ;;
      *) [[ -d "$HOME/Android/Sdk" ]] && ANDROID_ENV_SDK="$HOME/Android/Sdk" ;;
    esac
  fi
  if [[ -n "$ANDROID_ENV_SDK" && -d "$ANDROID_ENV_SDK" ]]; then
    echo "sdk.dir=$ANDROID_ENV_SDK" > "$ANDROID_ENV_ROOT/apps/android/local.properties"
    export ANDROID_HOME="$ANDROID_ENV_SDK"
    echo "==> wrote apps/android/local.properties (sdk.dir=$ANDROID_ENV_SDK)"
  else
    echo "ERROR: no Android SDK — Gradle will die with 'SDK location not found'." >&2
    echo "  export ANDROID_HOME=<sdk dir> (~/Library/Android/sdk on this Mac)" >&2
    echo "  or create apps/android/local.properties with sdk.dir=<sdk dir>" >&2
    return 1 2>/dev/null || exit 1
  fi
fi
