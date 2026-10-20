// remote-test.mjs defaults: repo root, target host and directories, the JDKs gradle may use,
// and the exit codes that mean the run never started or was voided.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Tailscale hostname first; the tailnet IP is only a fallback for when MagicDNS
// is not answering (this is a laptop-adjacent tailnet, so that happens).
export const DEFAULT_HOST = 'jfedora';
export const FALLBACK_HOSTS = ['100.90.52.106'];
export const DEFAULT_USER = 'justin';

// A dedicated CI worktree, NOT the box's own ~/Developer/futo-notes checkout —
// that one is somebody's live working tree and gets `git checkout --force`d
// out from under them otherwise.
export const DEFAULT_REMOTE_DIR = '$HOME/ci/futo-main';
export const DEFAULT_SOURCE_REPO = '$HOME/Developer/futo-notes';

// Gradle 8.14.3 (apps/android/gradle/wrapper) cannot run on Java 25, and
// Fedora's default JDK is 25 — gradle fails with a bare "What went wrong:
// 25.0.4", which names neither Java nor the version constraint. The app targets
// jvmTarget 17 and Gradle 8.14 fully supports 21, so pick a 21 (or 17) JDK
// rather than whatever `java` resolves to. Override with $FUTO_REMOTE_JAVA_HOME.
export const GRADLE_JDK_CANDIDATES = [
  '/usr/lib/jvm/java-21-openjdk',
  '/usr/lib/jvm/temurin-21-jdk',
  '/usr/lib/jvm/java-21-temurin-jdk',
  '/usr/lib/jvm/java-17-openjdk',
  '/usr/lib/jvm/temurin-17-jdk',
];

// Distinguishable from any suite's own failure: the run never started.
export const EXIT_REFUSED = 2;
export const EXIT_LOCKED = 75; // EX_TEMPFAIL
// The remote checkout moved mid-run: the result is void, not a test failure.
export const EXIT_MOVED = 76;
