import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Channel-safety conformance guard for the desktop updater.
 *
 * The whole "a prerelease tag can never poison permalink/latest" guarantee rests
 * on a SINGLE regex in the `release:` job rule in .gitlab-ci.yml. GitLab resolves
 * the baked `permalink/latest` endpoint by release DATE, so if `release:` ever
 * published on a prerelease tag, stable clients would be served that prerelease's
 * latest.json. updaterConfig.test.ts validates the config; nothing validated this
 * rule. This test extracts the actual regex from the YAML and pins its behavior,
 * so a well-meaning broadening (e.g. to publish -rc to a beta release) fails CI.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI = readFileSync(resolve(ROOT, '.gitlab-ci.yml'), 'utf8');

/** Pull the stable-tag regex out of the `$CI_COMMIT_TAG =~ /.../` release rule. */
function extractStableTagRegex() {
  // The only `=~` against $CI_COMMIT_TAG in the file is the release: channel gate.
  const m = CI.match(/\$CI_COMMIT_TAG\s*=~\s*\/(\^v.+?\$)\//);
  if (!m) throw new Error('could not find the $CI_COMMIT_TAG =~ /.../ release rule in .gitlab-ci.yml');
  return new RegExp(m[1]);
}

describe('release: channel gate (.gitlab-ci.yml)', () => {
  const re = extractStableTagRegex();

  it('publishes on stable semver tags', () => {
    for (const tag of ['v1.6.0', 'v0.0.1', 'v10.20.30', 'v2.0.0']) {
      expect(re.test(tag), `${tag} should publish`).toBe(true);
    }
  });

  it('NEVER publishes on prerelease tags (would poison permalink/latest)', () => {
    for (const tag of ['v1.6.0-rc.1', 'v1.6.0-nightly', 'v1.6.0-rc', 'v1.6.0-beta.2']) {
      expect(re.test(tag), `${tag} must NOT publish`).toBe(false);
    }
  });

  it('rejects build-metadata and malformed tags (publish only exact vX.Y.Z)', () => {
    for (const tag of ['v1.6.0+meta', 'v1.6', 'v1.6.0.0', '1.6.0', 'vfoo', 'v1.6.0 ', 'release-1.6.0']) {
      expect(re.test(tag), `${tag} must NOT publish`).toBe(false);
    }
  });
});
