// remote-test.mjs remote environment: the NDK pin and the shell preamble every remote script
// starts with.
import { GRADLE_JDK_CANDIDATES } from './settings.mjs';

// ---------------------------------------------------------------------------
// Remote environment
// ---------------------------------------------------------------------------

/**
 * The NDK AGP is pinned to. cargo-ndk must build the Rust .so with the SAME
 * NDK — apps/android/app/build.gradle.kts warns that a mismatch breaks NDK
 * resolution and silently skips stripping — so read the pin instead of
 * defaulting to "newest installed", which is how the two drift apart.
 */
export function ndkVersionFromGradle(gradleText) {
  const m = /ndkVersion\s*=\s*"([^"]+)"/.exec(gradleText);
  if (!m) throw new Error('no ndkVersion found in apps/android/app/build.gradle.kts');
  return m[1];
}

/**
 * Sourced on EVERY invocation: `ssh host cmd` is a non-interactive shell, so it
 * reads none of the box's profile — node lives in fnm and is simply absent from
 * PATH without this.
 */
export function remoteEnvPreamble({ ndkVersion }) {
  return [
    // No .bun/bin any more: the sync test server used to be a bun project, and
    // its absence from a non-interactive PATH killed the cross-platform suite
    // after both clients were already up. It is a pinned Go binary the harness
    // downloads now (scripts/lib/sync-server.mjs), so nothing here needs bun.
    // .local/share/fnm and linuxbrew cover fnm's two install layouts; this must
    // precede the `fnm env` below, which needs fnm itself on PATH.
    'export PATH="${FNM_DIR:-$HOME/.local/share/fnm}:$HOME/.fnm:$HOME/.local/bin:$HOME/.local/share/fnm:/home/linuxbrew/.linuxbrew/bin:$HOME/.cargo/bin:$PATH"',
    // Doctor must still run without fnm. Normal runs check it before taking
    // the worktree lock or transferring sources.
    'if command -v fnm >/dev/null 2>&1; then eval "$(fnm env --shell bash)"; fi',
    'export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"',
    'export ANDROID_SDK_ROOT="$ANDROID_HOME"',
    `export ANDROID_NDK_HOME="\${FUTO_REMOTE_NDK:-$ANDROID_HOME/ndk/${ndkVersion}}"`,
    // See GRADLE_JDK_CANDIDATES: Fedora's default JDK 25 is too new for the
    // pinned Gradle, so prefer an explicitly supported one when it exists.
    `for candidate in "\${FUTO_REMOTE_JAVA_HOME:-}" ${GRADLE_JDK_CANDIDATES.map((p) => `"${p}"`).join(' ')}; do`,
    '  if [ -n "$candidate" ] && [ -x "$candidate/bin/javac" ]; then',
    '    export JAVA_HOME="$candidate"',
    '    export PATH="$JAVA_HOME/bin:$PATH"',
    '    break',
    '  fi',
    'done',
    // CARGO_TARGET_DIR is deliberately NOT exported, and an inherited one is
    // cleared. The remote worktree's own `target/` is already a persistent warm
    // cache (git mode never touches it and --rsync excludes it), so relocating
    // it buys nothing — and cost real breakage twice:
    //   1. tests/lib/tauri-instance.mjs resolves the built binary as
    //      <repoRoot>/target/debug/futo-notes-tauri, and cross-platform-sync.mjs's
    //      pgrep cleanup only kills binaries under it (a deliberate guard). A
    //      relocated target dir made `just remote-sync` die with ENOENT AFTER an
    //      84-second build.
    //   2. scripts/ci-cargo-cache-freshness.mjs reads $CARGO_TARGET_DIR, so its
    //      unit tests inherited ours, inspected a directory that did not exist,
    //      concluded "no restored cache", and exited 0 where they assert 1 — five
    //      failures running `check` remotely that do not reproduce on the Mac.
    // Anything in this repo may reasonably assume the repo-local target/; honoring
    // that is cheaper than auditing every consumer.
    'unset CARGO_TARGET_DIR',
    // Deliberately NOT setting CI: `cargo tauri build` maps its `--ci` flag to
    // $CI, and an EMPTY CI makes clap reject the run ("a value is required for
    // '--ci'"). This broke `just remote-sync` before it was caught. vitest also
    // caps workers under CI, which would throw away the box's 32 cores.
    'unset CI',
  ].join('\n');
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
