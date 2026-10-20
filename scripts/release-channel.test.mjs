import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { readGitlabCiSource } from './lib/gitlab-ci.mjs';

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
const CI = readGitlabCiSource(ROOT);

/** Pull the stable-tag regex out of the `release:` job's `$CI_COMMIT_TAG =~ /.../` rule. */
function extractStableTagRegex() {
  // Several publish jobs carry the same guard; anchor on the `release:` job so a
  // broadening of THAT rule cannot hide behind an untouched sibling.
  const start = CI.search(/^release:\s*$/m);
  if (start === -1) throw new Error('could not find the release: job in .gitlab-ci.yml');
  const m = CI.slice(start).match(/\$CI_COMMIT_TAG\s*=~\s*\/(\^v.+?\$)\//);
  if (!m) throw new Error('could not find the $CI_COMMIT_TAG =~ /.../ rule in the release: job');
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
    for (const tag of [
      'v1.6.0+meta',
      'v1.6',
      'v1.6.0.0',
      '1.6.0',
      'vfoo',
      'v1.6.0 ',
      'release-1.6.0',
    ]) {
      expect(re.test(tag), `${tag} must NOT publish`).toBe(false);
    }
  });
});

/**
 * release:internal DOES create a GitLab Release for prerelease tags. GitLab resolves
 * `permalink/latest` by released_at, so an internal release stamped "now" becomes
 * `latest`, serves no latest.json, and 404s every production update check until the
 * next stable release (v1.9.0-3). The release must therefore be backdated.
 */
function releaseInternalJob() {
  const start = CI.search(/^release:internal:\s*$/m);
  if (start === -1) throw new Error('could not find the release:internal job in .gitlab-ci.yml');
  const body = CI.slice(CI.indexOf('\n', start) + 1);
  const next = body.search(/^\S/m);
  return next === -1 ? body : body.slice(0, next);
}

describe('release:internal never becomes permalink/latest (.gitlab-ci.yml)', () => {
  const job = releaseInternalJob();
  // The whole `release-cli create ...` command: backslash-continued lines.
  const createCmd = job.match(/^\s*release-cli create(?:[^\n]*\\\n)*[^\n]*/m);

  it('creates its release with release-cli', () => {
    expect(createCmd, 'release-cli create not found in release:internal').not.toBeNull();
  });

  it('backdates the release with --released-at far in the past', () => {
    const m = createCmd?.[0].match(/--released-at\s+"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"?/);
    expect(
      m,
      'release:internal must pass --released-at, or its release becomes permalink/latest',
    ).not.toBeNull();
    // Any first-stable-release-era date would be too late; the repo's first release is
    // long after 2020, so a date before it can never beat a stable release.
    expect(Date.parse(m[1]) < Date.parse('2021-01-01T00:00:00Z')).toBe(true);
  });

  it('does not backdate via a variable that could resolve to "now"', () => {
    expect(createCmd?.[0]).not.toMatch(/--released-at\s+"?\$/);
  });
});
