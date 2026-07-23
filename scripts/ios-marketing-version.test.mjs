import { describe, expect, it } from 'vitest';

import { bumpPatch, resolveMarketingVersion } from './ios-marketing-version.mjs';

describe('bumpPatch', () => {
  it('bumps the patch component', () => {
    expect(bumpPatch('1.6.0')).toBe('1.6.1');
  });

  it('strips a leading v and any prerelease suffix', () => {
    expect(bumpPatch('v1.6.0-rc.1')).toBe('1.6.1');
  });

  it('defaults missing components to zero', () => {
    expect(bumpPatch('2')).toBe('2.0.1');
  });
});

describe('resolveMarketingVersion', () => {
  it('uses the tag version on a semver release tag', () => {
    expect(resolveMarketingVersion({ tag: 'v1.6.0', latestReleaseTag: 'v1.5.5' })).toBe('1.6.0');
  });

  it('preserves a prerelease suffix on the tag', () => {
    expect(resolveMarketingVersion({ tag: 'v2.0.0-alpha.1', latestReleaseTag: 'v1.6.0' })).toBe(
      '2.0.0-alpha.1',
    );
  });

  it('patch-bumps the latest release for non-tag (main) builds', () => {
    expect(resolveMarketingVersion({ tag: '', latestReleaseTag: 'v1.6.0' })).toBe('1.6.1');
  });

  it('falls back when no release is known', () => {
    expect(resolveMarketingVersion({ tag: '', latestReleaseTag: null })).toBe('0.0.1');
  });
});
