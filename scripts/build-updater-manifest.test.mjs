import { describe, it, expect } from 'vitest';
import { buildManifest, KNOWN_PLATFORMS } from './build-updater-manifest.mjs';

const base = {
  version: '1.6.0',
  pubDate: '2026-06-24T00:00:00Z',
  platforms: [
    {
      platform: 'linux-x86_64',
      url: 'https://gitlab.futo.org/x/FUTO-Notes-1.6.0-x86_64.AppImage',
      signature: 'sig-linux',
    },
  ],
};

describe('buildManifest', () => {
  it('assembles a valid single-platform manifest', () => {
    const m = buildManifest(base);
    expect(m).toEqual({
      version: '1.6.0',
      notes: 'FUTO Notes 1.6.0',
      pub_date: '2026-06-24T00:00:00Z',
      platforms: {
        'linux-x86_64': { signature: 'sig-linux', url: base.platforms[0].url },
      },
    });
  });

  it('merges multiple platforms into one manifest', () => {
    const m = buildManifest({
      ...base,
      platforms: [
        { platform: 'linux-x86_64', url: 'https://h/a.AppImage', signature: 'a' },
        { platform: 'darwin-aarch64', url: 'https://h/b.app.tar.gz', signature: 'b' },
        { platform: 'windows-x86_64', url: 'https://h/c-setup.exe', signature: 'c' },
      ],
    });
    expect(Object.keys(m.platforms).sort()).toEqual([
      'darwin-aarch64',
      'linux-x86_64',
      'windows-x86_64',
    ]);
  });

  it('lets both macOS arch keys share one universal artifact (same url + sig)', () => {
    // The macOS .app.tar.gz is universal, so darwin-aarch64 and darwin-x86_64
    // both point at the same artifact + signature — Intel and Apple Silicon
    // clients each match their own key and download the one tarball.
    const url = 'https://h/FUTO-Notes-1.6.0-universal.app.tar.gz';
    const m = buildManifest({
      ...base,
      platforms: [
        { platform: 'darwin-aarch64', url, signature: 'mac' },
        { platform: 'darwin-x86_64', url, signature: 'mac' },
      ],
    });
    expect(m.platforms['darwin-aarch64']).toEqual({ url, signature: 'mac' });
    expect(m.platforms['darwin-x86_64']).toEqual({ url, signature: 'mac' });
  });

  it('keeps a custom notes string', () => {
    expect(buildManifest({ ...base, notes: 'Hotfix' }).notes).toBe('Hotfix');
  });

  it('trims surrounding whitespace from signatures (.sig files end in newline)', () => {
    const m = buildManifest({ ...base, platforms: [{ ...base.platforms[0], signature: 'sig\n' }] });
    expect(m.platforms['linux-x86_64'].signature).toBe('sig');
  });

  it('exposes the supported platform keys', () => {
    expect(KNOWN_PLATFORMS).toContain('linux-x86_64');
    expect(KNOWN_PLATFORMS).toContain('darwin-aarch64');
    expect(KNOWN_PLATFORMS).toContain('windows-x86_64');
  });

  describe('validation', () => {
    const linux = (url, signature = 's') => [{ platform: 'linux-x86_64', url, signature }];

    it.each([
      ['a non-semver version', { version: 'v1.6' }, /invalid version/],
      ['a non-RFC3339 pubDate', { pubDate: '2026-06-24' }, /invalid pubDate/],
      ['an empty platforms list', { platforms: [] }, /non-empty/],
      [
        'an unknown platform key',
        { platforms: [{ platform: 'solaris-sparc', url: 'https://h/x', signature: 's' }] },
        /unknown platform/,
      ],
      [
        'a non-https url (no plaintext download in prod)',
        { platforms: linux('http://h/x') },
        /must be https/,
      ],
      [
        'http://localhost by default (prod stays https-only)',
        { platforms: linux('http://localhost:8787/x.AppImage') },
        /must be https/,
      ],
      ['an empty signature', { platforms: linux('https://h/x', '  ') }, /empty signature/],
      [
        'duplicate platform keys',
        { platforms: [...linux('https://h/a', 'a'), ...linux('https://h/b', 'b')] },
        /duplicate platform/,
      ],
    ])('rejects %s', (_label, overrides, error) => {
      expect(() => buildManifest({ ...base, ...overrides })).toThrow(error);
    });

    it('allows http://localhost ONLY with allowInsecureLocalhost (the localdev profile)', () => {
      const m = buildManifest({
        ...base,
        allowInsecureLocalhost: true,
        platforms: linux('http://localhost:8787/x.AppImage'),
      });
      expect(m.platforms['linux-x86_64'].url).toBe('http://localhost:8787/x.AppImage');
      const m2 = buildManifest({
        ...base,
        allowInsecureLocalhost: true,
        platforms: linux('http://127.0.0.1:8787/x'),
      });
      expect(m2.platforms['linux-x86_64'].url).toBe('http://127.0.0.1:8787/x');
    });

    it('still rejects a non-localhost http url even with allowInsecureLocalhost', () => {
      expect(() =>
        buildManifest({
          ...base,
          allowInsecureLocalhost: true,
          platforms: linux('http://evil.com/x'),
        }),
      ).toThrow(/must be https/);
      // not fooled by a localhost-prefixed hostname
      expect(() =>
        buildManifest({
          ...base,
          allowInsecureLocalhost: true,
          platforms: linux('http://localhost.evil.com/x'),
        }),
      ).toThrow(/must be https/);
    });
  });
});
