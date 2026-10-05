import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

const daemonCriteria = read('apps/android/gradle/gradle-daemon-jvm.properties');

function pinnedDaemonJdkVersion(criteria) {
  return /^toolchainVersion=(\d+)$/m.exec(criteria)?.[1] ?? null;
}

// Gradle 8.14.3's Kotlin DSL compiler cannot parse a Java 25 runtime version and
// reports the failure as the version string alone ("What went wrong:" /
// "25.0.2"), naming neither Java nor a constraint. Android Studio's bundled JBR
// is the only java on PATH on a typical dev Mac and is now 25, so every Gradle
// entry point inherited a JDK that cannot run this build. The criteria file is
// the ONE place that fixes it; these tests keep it that way.
describe('Android Gradle JDK pin', () => {
  it('pins the daemon JVM in the one place every entry point reads', () => {
    expect(pinnedDaemonJdkVersion(daemonCriteria)).toBe('21');
  });

  it('agrees with the JDK baked into the CI Android image', () => {
    const baked = /ENV JAVA_HOME=\/opt\/jdk-(\d+)/.exec(read('ci/android.Dockerfile'));
    expect(baked).not.toBeNull();
    // A mismatch is not a hard failure — Gradle would just relaunch onto another
    // JDK — but it silently throws away the point of a prebaked image, so catch
    // it here instead of in a slow pipeline.
    expect(baked[1]).toBe(pinnedDaemonJdkVersion(daemonCriteria));
  });

  it('has no entry point exporting JAVA_HOME to work around a Gradle version error', () => {
    // The Android playbook used to tell agents to point JAVA_HOME at Android
    // Studio's JBR. That is a second answer that can disagree with the criteria
    // file. Image and CI provisioning (ci/android.Dockerfile, .gitlab-ci.yml)
    // may still set JAVA_HOME — that installs a JDK rather than choosing one.
    for (const entryPoint of [
      'apps/android/run.sh',
      'scripts/build-rust-android.sh',
      'scripts/ci-android-instrumentation.sh',
      'scripts/android-env.sh',
      'justfile',
    ]) {
      expect(read(entryPoint), `${entryPoint} exports JAVA_HOME`).not.toMatch(/JAVA_HOME=/);
    }
  });
});
