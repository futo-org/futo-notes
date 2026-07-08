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
    it('rejects a non-semver version', () => {
      expect(() => buildManifest({ ...base, version: 'v1.6' })).toThrow(/invalid version/);
    });

    it('rejects a non-RFC3339 pubDate', () => {
      expect(() => buildManifest({ ...base, pubDate: '2026-06-24' })).toThrow(/invalid pubDate/);
    });

    it('rejects an empty platforms list', () => {
      expect(() => buildManifest({ ...base, platforms: [] })).toThrow(/non-empty/);
    });

    it('rejects an unknown platform key', () => {
      expect(() =>
        buildManifest({
          ...base,
          platforms: [{ platform: 'solaris-sparc', url: 'https://h/x', signature: 's' }],
        }),
      ).toThrow(/unknown platform/);
    });

    it('rejects a non-https url (no plaintext download in prod)', () => {
      expect(() =>
        buildManifest({
          ...base,
          platforms: [{ platform: 'linux-x86_64', url: 'http://h/x', signature: 's' }],
        }),
      ).toThrow(/must be https/);
    });

    it('rejects http://localhost by default (prod stays https-only)', () => {
      expect(() =>
        buildManifest({
          ...base,
          platforms: [
            { platform: 'linux-x86_64', url: 'http://localhost:8787/x.AppImage', signature: 's' },
          ],
        }),
      ).toThrow(/must be https/);
    });

    it('allows http://localhost ONLY with allowInsecureLocalhost (the localdev profile)', () => {
      const m = buildManifest({
        ...base,
        allowInsecureLocalhost: true,
        platforms: [
          { platform: 'linux-x86_64', url: 'http://localhost:8787/x.AppImage', signature: 's' },
        ],
      });
      expect(m.platforms['linux-x86_64'].url).toBe('http://localhost:8787/x.AppImage');
      const m2 = buildManifest({
        ...base,
        allowInsecureLocalhost: true,
        platforms: [{ platform: 'linux-x86_64', url: 'http://127.0.0.1:8787/x', signature: 's' }],
      });
      expect(m2.platforms['linux-x86_64'].url).toBe('http://127.0.0.1:8787/x');
    });

    it('still rejects a non-localhost http url even with allowInsecureLocalhost', () => {
      expect(() =>
        buildManifest({
          ...base,
          allowInsecureLocalhost: true,
          platforms: [{ platform: 'linux-x86_64', url: 'http://evil.com/x', signature: 's' }],
        }),
      ).toThrow(/must be https/);
      // not fooled by a localhost-prefixed hostname
      expect(() =>
        buildManifest({
          ...base,
          allowInsecureLocalhost: true,
          platforms: [
            { platform: 'linux-x86_64', url: 'http://localhost.evil.com/x', signature: 's' },
          ],
        }),
      ).toThrow(/must be https/);
    });

    it('rejects an empty signature', () => {
      expect(() =>
        buildManifest({
          ...base,
          platforms: [{ platform: 'linux-x86_64', url: 'https://h/x', signature: '  ' }],
        }),
      ).toThrow(/empty signature/);
    });

    it('rejects duplicate platform keys', () => {
      expect(() =>
        buildManifest({
          ...base,
          platforms: [
            { platform: 'linux-x86_64', url: 'https://h/a', signature: 'a' },
            { platform: 'linux-x86_64', url: 'https://h/b', signature: 'b' },
          ],
        }),
      ).toThrow(/duplicate platform/);
    });
  });
});
