import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { resolveAndroidNdk, resolveAndroidSdk } from './lib/android-toolchain.mjs';
import { ndkVersionFromGradle as remoteNdkVersion } from './remote-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = [];
const pin = '28.2.13676358';

it('the remote runner retains the shared Gradle NDK pin parser', () => {
  expect(remoteNdkVersion(`android { ndkVersion = "${pin}" }`)).toBe(pin);
  expect(() => remoteNdkVersion('android {}')).toThrow('no ndkVersion found');
});

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-setup-'));
  scratch.push(directory);
  const write = (relative, contents) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  write('.nvmrc', process.version.slice(1));
  write('package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  write('apps/android/app/build.gradle.kts', `android { ndkVersion = "${pin}" }`);
  write('node_modules/.bin/vite', 'fixture');
  const sdk = path.join(directory, 'sdk');
  write(`sdk/ndk/${pin}/source.properties`, `Pkg.Revision = ${pin}\n`);
  for (const command of ['git', 'just', 'cargo', 'rustc', 'pnpm', 'java']) {
    const output =
      command === 'pnpm' ? '10.0.0' : command === 'java' ? 'java.version = 21' : 'fixture';
    const file = write(
      `bin/${command}`,
      `#!/bin/sh\nprintf '%s\\n' '${output}' ${command === 'java' ? '>&2' : ''}\n`,
    );
    fs.chmodSync(file, 0o755);
  }
  const env = {
    ...process.env,
    HOME: directory,
    PATH: path.join(directory, 'bin'),
    ANDROID_HOME: sdk,
    npm_config_user_agent: 'pnpm/10.0.0',
  };
  for (const key of ['ANDROID_NDK_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME']) delete env[key];
  return { directory, sdk, env, write };
}

function preflight({ directory, env }) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts/setup-worktree.mjs'), 'android', '--check'],
    {
      cwd: directory,
      env,
      encoding: 'utf8',
    },
  );
}

it('Android preflight accepts the installed pinned NDK without ANDROID_NDK_HOME', () => {
  const result = preflight(fixture());
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`OK Android NDK pin: ${pin}`);
});

it.each(['ANDROID_SDK_ROOT', 'default location'])(
  'Android preflight discovers the SDK through %s',
  (source) => {
    const state = fixture();
    delete state.env.ANDROID_HOME;
    if (source === 'ANDROID_SDK_ROOT') state.env.ANDROID_SDK_ROOT = state.sdk;
    else {
      const relative = process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk';
      state.write(`${relative}/ndk/${pin}/source.properties`, `Pkg.Revision = ${pin}\n`);
    }
    const result = preflight(state);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  },
);

it.each(['darwin', 'linux'])('SDK discovery uses the standard %s location', (platform) => {
  const state = fixture();
  const relative = platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk';
  state.write(`${relative}/installed`, 'fixture');
  expect(resolveAndroidSdk({ env: {}, home: state.directory, platform })).toBe(
    path.join(state.directory, relative),
  );
});

it('preflight honors a matching explicit NDK override outside the SDK', () => {
  const state = fixture();
  state.write('custom-ndk/source.properties', `Pkg.Revision = ${pin}\n`);
  state.env.ANDROID_NDK_HOME = path.join(state.directory, 'custom-ndk');
  fs.rmSync(path.join(state.sdk, 'ndk', pin), { recursive: true });
  const result = preflight(state);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

it.each(['29.0.0', `${pin}1`, 'missing'])(
  'preflight rejects an explicit NDK override with revision %s',
  (revision) => {
    const state = fixture();
    state.write('custom-ndk/source.properties', `Pkg.Revision = ${revision}\n`);
    state.env.ANDROID_NDK_HOME = path.join(state.directory, 'custom-ndk');
    const result = preflight(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `MISSING Android NDK pin: ANDROID_NDK_HOME must contain NDK ${pin}`,
    );
  },
);

it('preflight fails with the required pin when only a newer NDK is installed', () => {
  const state = fixture();
  fs.rmSync(path.join(state.sdk, 'ndk', pin), { recursive: true });
  state.write('sdk/ndk/29.0.0/source.properties', 'Pkg.Revision = 29.0.0\n');
  const result = preflight(state);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`MISSING Android NDK pin: NDK ${pin} not found`);
  expect(result.stderr).toContain('install it with SDK Manager');
});

it('SDK discovery refuses a bad explicit path instead of hiding it with a fallback', () => {
  const state = fixture();
  expect(() =>
    resolveAndroidSdk({ env: { ANDROID_HOME: path.join(state.directory, 'missing') } }),
  ).toThrow('set ANDROID_HOME to the installed SDK directory');
});

it('the resolver selects the Gradle pin when a newer NDK is also installed', () => {
  const state = fixture();
  state.write('sdk/ndk/29.0.0/source.properties', 'Pkg.Revision = 29.0.0\n');
  expect(resolveAndroidNdk({ root: state.directory, env: state.env })).toEqual({
    directory: path.join(state.sdk, 'ndk', pin),
    version: pin,
  });
});

function buildUntilCargo(state) {
  // Copy only the build entry point and its resolver into our own disposable
  // tree. The first cargo call exits deliberately, before any Rust build.
  for (const relative of ['scripts/build-rust-android.sh', 'scripts/lib/android-toolchain.mjs']) {
    state.write(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
  }
  fs.symlinkSync(process.execPath, path.join(state.directory, 'bin/node'));
  fs.chmodSync(state.write('bin/cargo-ndk', '#!/bin/sh\nexit 0\n'), 0o755);
  fs.chmodSync(
    state.write(
      'bin/cargo',
      '#!/bin/sh\nprintf "selected-ndk=%s\\n" "$ANDROID_NDK_HOME"\nexit 73\n',
    ),
    0o755,
  );
  return spawnSync('/bin/bash', [path.join(state.directory, 'scripts/build-rust-android.sh')], {
    cwd: state.directory,
    env: { ...state.env, PATH: `${state.env.PATH}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
}

it('the Rust build discovers and exports the same pinned NDK before invoking cargo', () => {
  const state = fixture();
  state.write('sdk/ndk/29.0.0/source.properties', 'Pkg.Revision = 29.0.0\n');
  const result = buildUntilCargo(state);
  expect(result.status).toBe(73);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain(`selected-ndk=${path.join(state.sdk, 'ndk', pin)}`);
});

it('the Rust build stops on an invalid explicit NDK before cleanup or cargo', () => {
  const state = fixture();
  state.env.ANDROID_NDK_HOME = path.join(state.directory, 'missing');
  const sentinel = state.write('apps/android/app/src/main/jniLibs/keep', 'fixture');
  const result = buildUntilCargo(state);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`NDK ${pin} not found`);
  expect(result.stdout).not.toContain('selected-ndk=');
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('fixture');
});
