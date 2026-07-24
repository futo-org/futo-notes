import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCommandEnvironment,
  buildConfigArguments,
  buildOne,
  bumpPatch,
  finalizeAppImageArtifact,
  hostTarget,
  parseFlags,
  patchAppImage,
} from './release-build.mjs';
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
  it('maps linux → AppImage with the post-bundle patch enabled', () => {
    const t = hostTarget('linux', 'x64');
    expect(t).toMatchObject({
      platform: 'linux-x86_64',
      bundle: 'appimage',
      suffix: '.AppImage',
      patchAppImage: true,
    });
  });

  it('maps macOS → app.tar.gz (NOT the .dmg), per-arch key, no AppImage patch', () => {
    expect(hostTarget('darwin', 'arm64')).toMatchObject({
      platform: 'darwin-aarch64',
      bundle: 'app',
      suffix: '.app.tar.gz',
      patchAppImage: false,
    });
    expect(hostTarget('darwin', 'x64')).toMatchObject({ platform: 'darwin-x86_64' });
  });

  it('maps Windows → NSIS setup.exe, per-arch key', () => {
    expect(hostTarget('win32', 'x64')).toMatchObject({
      platform: 'windows-x86_64',
      bundle: 'nsis',
      suffix: '-setup.exe',
      patchAppImage: false,
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

  it('the AppImage-patch flag is set ONLY for linux', () => {
    expect(hostTarget('linux', 'x64').patchAppImage).toBe(true);
    expect(hostTarget('darwin', 'arm64').patchAppImage).toBe(false);
    expect(hostTarget('win32', 'x64').patchAppImage).toBe(false);
  });
});

describe('AppImage artifact finalization', () => {
  it('patches the AppImage before signing its final bytes', () => {
    const events = [];

    finalizeAppImageArtifact({
      dir: '/bundle/appimage',
      artifact: '/bundle/appimage/FUTO-Notes.AppImage',
      profile: 'prod',
      patch: (dir) => events.push(['patch', dir]),
      sign: (artifact, profile) => events.push(['sign', artifact, profile]),
    });

    expect(events).toEqual([
      ['patch', '/bundle/appimage'],
      ['sign', '/bundle/appimage/FUTO-Notes.AppImage', 'prod'],
    ]);
  });

  it('the production build workflow patches before accepting and verifying the final signature', () => {
    const artifact = '/bundle/appimage/FUTO-Notes.AppImage';
    const events = [];

    const result = buildOne(
      { profile: 'prod', version: '1.2.3' },
      {
        target: {
          platform: 'linux-x86_64',
          bundle: 'appimage',
          dir: '/bundle/appimage',
          suffix: '.AppImage',
          patchAppImage: true,
        },
        setBuildVersion: (version) => events.push(['version', version]),
        removeBundle: (dir) => events.push(['remove', dir]),
        executeBuild: () => events.push(['build']),
        locateArtifact: () => artifact,
        finalizeArtifact: ({ dir, artifact: finalArtifact, profile }) =>
          events.push(['finalize', dir, finalArtifact, profile]),
        fileExists: (path) => path === `${artifact}.sig`,
        getProfilePubkey: () => 'test-pubkey',
        verifySignature: ({ artifactPath, sigPath }) => {
          events.push(['verify', artifactPath, sigPath]);
          return { ok: true };
        },
      },
    );

    expect(events).toEqual([
      ['version', '1.2.3'],
      ['remove', '/bundle/appimage'],
      ['build'],
      ['finalize', '/bundle/appimage', artifact, 'prod'],
      ['verify', artifact, `${artifact}.sig`],
    ]);
    expect(result).toEqual({
      platform: 'linux-x86_64',
      artifact,
      sig: `${artifact}.sig`,
      suffix: '.AppImage',
    });
  });

  it('fails when the required AppImage patch script is missing', () => {
    const missingScript = fileURLToPath(
      new URL('./definitely-missing-patch-appimage.mjs', import.meta.url),
    );

    expect(() => patchAppImage('/bundle/appimage', { scriptPath: missingScript })).toThrow(
      `AppImage patch script missing at ${missingScript}`,
    );
  });

  it('does not expose updater signing variables to the patch process', () => {
    const scriptPath = fileURLToPath(new URL('./patch-appimage.mjs', import.meta.url));
    const calls = [];

    patchAppImage('/bundle/appimage', {
      scriptPath,
      environment: {
        PATH: '/usr/bin',
        TAURI_SIGNING_PRIVATE_KEY: 'production-secret',
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'production-password',
      },
      execute: (command, args, options) => calls.push({ command, args, options }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'node',
      args: [scriptPath, '--dir', '/bundle/appimage'],
    });
    expect(calls[0].options.env.PATH).toBe('/usr/bin');
    expect(calls[0].options.env.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(calls[0].options.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBeUndefined();
  });

  it('builds Linux updater bytes keyless and disables build-time updater artifacts', () => {
    const target = hostTarget('linux', 'x64');
    const environment = buildCommandEnvironment('prod', target, {
      PATH: '/usr/bin',
      TAURI_SIGNING_PRIVATE_KEY: 'production-secret',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'production-password',
    });
    const configArguments = buildConfigArguments('prod', target);

    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.NO_STRIP).toBe('true');
    expect(environment.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBeUndefined();
    expect(configArguments.slice(-2, -1)).toEqual(['--config']);
    expect(JSON.parse(configArguments.at(-1))).toEqual({
      bundle: { createUpdaterArtifacts: false },
    });
  });
});

describe('AppImage CI rehearsal', () => {
  it('uses the fixture key only for MRs and verifies the one produced artifact', () => {
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    const job = ci.slice(
      ci.indexOf('build:linux-appimage:'),
      ci.indexOf('build:ci-android-image:'),
    );

    expect(job).toContain('if [ -n "$CI_COMMIT_TAG" ]');
    expect(job).toContain('prepare-appimage-signing-environment.sh');
    expect(job).toContain('keys/localdev-updater.key');
    expect(job).toContain('TAURI_SIGNING_PRIVATE_KEY="$SIGNING_KEY" cargo tauri signer sign');
    expect(job).toContain('expected exactly one AppImage');
    expect(job).toContain('scripts/verify-updater-signature.mjs');
    expect(job).toContain('scripts/patch-appimage.mjs" --clean-dir');
  });

  it('falls back to the checked-in desktop version when an MR has no tag', () => {
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    const setVersion = ci.slice(
      ci.indexOf('.set-version:'),
      ci.indexOf('.setup-futo-notes-server:'),
    );

    expect(setVersion).toContain('--resolve-ci "${CI_COMMIT_TAG:-}"');
    expect(setVersion).toContain('node "$CI_PROJECT_DIR/scripts/desktop-version.mjs" "$VERSION"');
  });

  it.each([
    {
      name: 'tag',
      tag: 'v1.2.3',
      expectedRetainedKey: 'production-secret',
    },
    {
      name: 'MR with a surprisingly available protected variable',
      tag: '',
      expectedRetainedKey: '',
    },
  ])('removes updater keys before every $name build subprocess', ({ tag, expectedRetainedKey }) => {
    const script = fileURLToPath(
      new URL('./prepare-appimage-signing-environment.sh', import.meta.url),
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        '. "$1"; printf "%s|%s|%s" "${RELEASE_SIGNING_KEY:-}" "${TAURI_SIGNING_PRIVATE_KEY+set}" "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}"',
        'bash',
        script,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          CI_COMMIT_TAG: tag,
          TAURI_SIGNING_PRIVATE_KEY: 'production-secret',
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'production-password',
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${expectedRetainedKey}||`);
  });

  it('retains the AppImage Cargo cache after failed tag-only rehearsals', () => {
    const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
    const cache = ci.slice(
      ci.indexOf('.cache-cargo-tauri-linux-appimage:'),
      ci.indexOf('build:linux-packages:'),
    );

    expect(cache).toContain('when: always');
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
