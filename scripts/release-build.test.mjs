import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFlags, bumpPatch, hostTarget } from './release-build.mjs';
import { KNOWN_PLATFORMS } from './build-updater-manifest.mjs';

describe('parseFlags', () => {
  it('parses --key value pairs', () => {
    expect(parseFlags(['--profile', 'localdev', '--version', '1.2.3'])).toEqual({
      profile: 'localdev',
      version: '1.2.3',
    });
  });

  it('treats a flag with no following value (or another flag) as boolean true', () => {
    // (the str() coercion in release-build.mjs turns these back into a clean
    //  error / default instead of crashing on `true.replace(...)`)
    expect(parseFlags(['--serve', '--profile', 'prod'])).toEqual({ serve: true, profile: 'prod' });
    expect(parseFlags(['--base-url'])).toEqual({ 'base-url': true });
  });

  it('returns empty for no args', () => {
    expect(parseFlags([])).toEqual({});
  });
});

describe('bumpPatch', () => {
  it('bumps the patch component', () => {
    expect(bumpPatch('1.6.0')).toBe('1.6.1');
    expect(bumpPatch('0.1.0')).toBe('0.1.1');
    expect(bumpPatch('2.10.9')).toBe('2.10.10');
  });

  it('preserves a prerelease/build suffix', () => {
    expect(bumpPatch('1.6.0-rc.1')).toBe('1.6.1-rc.1');
  });
});

describe('hostTarget — per-OS updater artifact shape', () => {
  it('maps linux → AppImage (and re-signs after the mesa patch)', () => {
    const t = hostTarget('linux', 'x64');
    expect(t).toMatchObject({
      platform: 'linux-x86_64',
      bundle: 'appimage',
      suffix: '.AppImage',
      mesaPatch: true,
    });
  });

  it('maps macOS → app.tar.gz (NOT the .dmg), per-arch key, no mesa patch', () => {
    expect(hostTarget('darwin', 'arm64')).toMatchObject({
      platform: 'darwin-aarch64',
      bundle: 'app',
      suffix: '.app.tar.gz',
      mesaPatch: false,
    });
    expect(hostTarget('darwin', 'x64')).toMatchObject({ platform: 'darwin-x86_64' });
  });

  it('maps Windows → NSIS setup.exe, per-arch key', () => {
    expect(hostTarget('win32', 'x64')).toMatchObject({
      platform: 'windows-x86_64',
      bundle: 'nsis',
      suffix: '-setup.exe',
      mesaPatch: false,
    });
    expect(hostTarget('win32', 'arm64')).toMatchObject({ platform: 'windows-aarch64' });
  });

  it('every shipped target yields a platform key the manifest accepts', () => {
    // linux-aarch64 is intentionally not shipped, so skip it.
    for (const [plat, arch] of [
      ['linux', 'x64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['win32', 'x64'],
      ['win32', 'arm64'],
    ]) {
      expect(KNOWN_PLATFORMS).toContain(hostTarget(plat, arch).platform);
    }
  });

  it('the mesa-patch flag is set ONLY for linux (the only re-sign-after-mutation OS here)', () => {
    expect(hostTarget('linux', 'x64').mesaPatch).toBe(true);
    expect(hostTarget('darwin', 'arm64').mesaPatch).toBe(false);
    expect(hostTarget('win32', 'x64').mesaPatch).toBe(false);
  });
});

describe('CLI entry point', () => {
  // Regression: the entry guard used `import.meta.url === \`file://${process.argv[1]}\``,
  // which assumed a POSIX path. On Windows argv[1] is `C:\…\release-build.mjs`
  // (backslashes + drive letter), so the guard was always false, main() never ran,
  // and `node scripts/release-build.mjs build …` exited 0 having built nothing.
  // Running the script directly here proves the guard fires (pathToFileURL fix).
  // Pre-fix this FAILS on Windows (empty stdout); it guards the entry on every OS.
  it('fires when the script is run directly (prints USAGE for no args)', () => {
    const script = fileURLToPath(new URL('./release-build.mjs', import.meta.url));
    const res = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage: node scripts/release-build.mjs');
  });
});
