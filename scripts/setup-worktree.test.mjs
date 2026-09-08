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
