import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./setup-worktree.mjs', import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

it('reports missing Android SDK/NDK before dependency installation or Rust builds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-worktree-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, '.nvmrc'), process.version.slice(1));
  fs.copyFileSync(new URL('../package.json', import.meta.url), path.join(root, 'package.json'));
  fs.mkdirSync(path.join(root, 'apps/android/app'), { recursive: true });
  fs.copyFileSync(
    new URL('../apps/android/app/build.gradle.kts', import.meta.url),
    path.join(root, 'apps/android/app/build.gradle.kts'),
  );
  const env = { ...process.env };
  delete env.ANDROID_HOME;
  delete env.ANDROID_NDK_HOME;
  const result = spawnSync(process.execPath, [script, 'android'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('MISSING Android SDK');
  expect(result.stderr).toContain('MISSING Android NDK pin');
  expect(result.stderr).toContain('Setup blocked before builds:');
  for (const dir of ['node_modules', 'target', 'dist'])
    expect(fs.existsSync(path.join(root, dir))).toBe(false);
}, 35000);

// A worktree whose `.nvmrc`/package.json match this process (so only the pnpm
// pin check is exercised) with a fake `pnpm` on PATH that reports a version
// other than the pin, distinguishing which code path the check took: reading
// the user agent (ignores the fake binary entirely) vs. spawning it.
function makeWorktreeForPnpmCheck(fakePnpmVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-worktree-pnpm-'));
  fs.writeFileSync(path.join(root, '.nvmrc'), process.version.slice(1));
  fs.copyFileSync(new URL('../package.json', import.meta.url), path.join(root, 'package.json'));
  const binDir = path.join(root, 'fake-bin');
  fs.mkdirSync(binDir);
  const pnpmStub = path.join(binDir, 'pnpm');
  fs.writeFileSync(pnpmStub, `#!/bin/sh\necho "${fakePnpmVersion}"\n`);
  fs.chmodSync(pnpmStub, 0o755);
  return { root, binDir };
}

it('nested under pnpm: reads the pin from npm_config_user_agent instead of spawning pnpm', () => {
  const { root, binDir } = makeWorktreeForPnpmCheck('99.99.99');
  roots.push(root);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    npm_config_user_agent: 'pnpm/10.29.2 npm/? node/v22 darwin x64',
  };
  const result = spawnSync(process.execPath, [script, 'portable', '--check'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  // The fake pnpm on PATH reports 99.99.99; if the check spawned it, the pin
  // would fail. It doesn't, because the user agent (10.29.2, the real pin) is
  // used instead.
  expect(result.stderr).not.toContain('MISSING pnpm pin');
  expect(result.stdout).toContain('OK pnpm pin: 10.29.2');
}, 35000);

it('not under pnpm: spawns pnpm --version to check the pin', () => {
  const { root, binDir } = makeWorktreeForPnpmCheck('99.99.99');
  roots.push(root);
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  delete env.npm_config_user_agent;
  delete env.npm_execpath;
  const result = spawnSync(process.execPath, [script, 'portable', '--check'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  // No pnpm in the environment to read from, so the check spawns the fake
  // pnpm on PATH, which reports the wrong version.
  expect(result.stderr).toContain('MISSING pnpm pin');
  expect(result.stderr).toContain('expected 10.29.2, got 99.99.99');
}, 35000);
