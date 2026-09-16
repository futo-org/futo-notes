import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envScript = readFileSync(join(ROOT, 'scripts/android-env.sh'), 'utf8');
const runSh = readFileSync(join(ROOT, 'apps/android/run.sh'), 'utf8');
const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');

// The guard's whole value is WHEN it runs: a JDK 25+ or a missing SDK location
// is knowable in ~2s, but if the check moves after the Rust/FFI build the
// failure again lands 10-25 minutes in, looking like a corrupt build file
// ("IllegalArgumentException: 25.0.2") or an unrelated setup bug ("SDK
// location not found") — the seven-report papercut this guard exists for.
// These assertions pin the wiring, not the shell logic.
describe('android environment guard wiring', () => {
  it('run.sh checks the environment before any build step', () => {
    const guardAt = runSh.indexOf('source scripts/android-env.sh');
    const jsDepsAt = runSh.indexOf('echo "==> JS deps"');
    const rustBuildAt = runSh.indexOf('bash scripts/build-rust-android.sh');

    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(jsDepsAt);
    expect(guardAt).toBeLessThan(rustBuildAt);
  });

  it('every Gradle recipe checks the environment before the Rust/FFI build', () => {
    // Match the recipe NAME at the start of a line up to its colon, not a
    // literal 'name:' substring — recipe declarations can carry parameters
    // (e.g. `deploy-android flavor="direct":`), which would otherwise break
    // this the moment a flavor argument (or any other param) is added.
    const findDeclaration = (recipeName) => {
      // (?=\s|:) rather than \b: 'test-android-native' is itself a prefix of
      // 'test-android-native-ui', and \b alone matches at that '-' too.
      const re = new RegExp(`^${recipeName}(?=\\s|:)[^\\n]*:`, 'm');
      const match = re.exec(justfile);
      expect(match, `recipe '${recipeName}' not found in justfile`).not.toBeNull();
      return { at: match.index, declaration: match[0] };
    };

    const gradleRecipes = [
      'build-android-native',
      'test-android-native',
      'test-android-native-ui',
      'deploy-android',
    ];
    for (const recipeName of gradleRecipes) {
      const { at } = findDeclaration(recipeName);
      const body = justfile.slice(at, at + 200);
      expect(body).toContain('android-env-check');
    }

    // Dependent recipes list the guard BEFORE build-rust-android: just runs
    // dependencies in the order listed.
    for (const recipeName of ['build-android-native', 'test-android-native', 'test-android-native-ui']) {
      const { declaration } = findDeclaration(recipeName);
      expect(declaration.indexOf('android-env-check')).toBeLessThan(
        declaration.indexOf('build-rust-android'),
      );
    }
  });

  it('the guard names the JDK requirement and the real Gradle error', () => {
    // The original failure mode was an error that named neither the JDK nor
    // any actionable fix. The message must keep both, so a future agent
    // greps their way here.
    expect(envScript).toContain('IllegalArgumentException: 25.0.2');
    expect(envScript).toContain('Install JDK 21');
    expect(envScript).toContain('SDK location not found');
  });
});
