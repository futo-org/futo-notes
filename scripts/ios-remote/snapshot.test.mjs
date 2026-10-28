import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  statSync,
  utimesSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotSource } from './snapshot.mjs';

const apply = fileURLToPath(new URL('./apply-snapshot.py', import.meta.url));
const dirs = [];
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ios-remote-source-'));
  dirs.push(root);
  const local = path.join(root, 'local');
  mkdirSync(local);
  git(local, 'init', '-q');
  writeFileSync(path.join(local, '.gitignore'), 'target/\n');
  writeFileSync(path.join(local, 'keep.mjs'), 'old');
  writeFileSync(path.join(local, 'deleted.mjs'), 'delete');
  git(local, 'add', '.');
  git(
    local,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  git(local, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const remote = path.join(root, 'remote');
  git(root, 'clone', '-q', local, remote);
  return { root, local, remote };
}
function snapshot(local, root) {
  const scratch = mkdtempSync(path.join(root, 'snapshot-'));
  const result = snapshotSource(local, scratch);
  return { ...result, scratch };
}
const transfer = (remote, source) =>
  spawnSync(
    'python3',
    [
      apply,
      remote,
      path.join(source.scratch, 'manifest.json'),
      path.join(source.scratch, 'source.tar.gz'),
    ],
    { encoding: 'utf8' },
  );
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('native remote source snapshots', () => {
  it('copies dirty and untracked source, removes deleted source, and preserves ignored caches', () => {
    const { root, local, remote } = fixture();
    writeFileSync(path.join(local, 'keep.mjs'), 'dirty');
    writeFileSync(path.join(local, 'two words $HOME.md'), 'literal');
    rmSync(path.join(local, 'deleted.mjs'));
    mkdirSync(path.join(local, 'target'));
    writeFileSync(path.join(local, 'target', 'private.db'), 'local cache');
    mkdirSync(path.join(remote, 'target'));
    writeFileSync(path.join(remote, 'target', 'private.db'), 'remote cache');
    const source = snapshot(local, root);
    expect(source.files).not.toContain('target/private.db');
    writeFileSync(path.join(local, 'keep.mjs'), 'later edit after capture');
    const result = transfer(remote, source);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(remote, 'keep.mjs'), 'utf8')).toBe('dirty');
    expect(readFileSync(path.join(remote, 'two words $HOME.md'), 'utf8')).toBe('literal');
    expect(existsSync(path.join(remote, 'deleted.mjs'))).toBe(false);
    expect(readFileSync(path.join(remote, 'target', 'private.db'), 'utf8')).toBe('remote cache');
  });

  it('never prunes through a directory symlink outside the managed worktree', () => {
    const { root, local, remote } = fixture();
    mkdirSync(path.join(remote, 'elsewhere'));
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'victim.md'), 'preserve');
    symlinkSync(outside, path.join(remote, 'shadow'), 'dir');
    writeFileSync(
      path.join(remote, '.git', 'futo-ios-remote-manifest.json'),
      '["shadow/victim.md"]',
    );
    const result = transfer(remote, snapshot(local, root));
    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(outside, 'victim.md'), 'utf8')).toBe('preserve');
  });

  it('rejects a protected or traversing manifest before pruning anything', () => {
    const { root, local, remote } = fixture();
    const source = snapshot(local, root);
    writeFileSync(path.join(source.scratch, 'manifest.json'), '["../outside"]');
    const result = transfer(remote, source);
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(remote, 'deleted.mjs'))).toBe(true);
  });
  it('removes only previously copied untracked source on a later snapshot', () => {
    const { root, local, remote } = fixture();
    writeFileSync(path.join(local, 'temporary-source.mjs'), 'source');
    expect(transfer(remote, snapshot(local, root)).status).toBe(0);
    writeFileSync(path.join(remote, 'manual-data.txt'), 'preserve');
    rmSync(path.join(local, 'temporary-source.mjs'));
    const result = transfer(remote, snapshot(local, root));
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(remote, 'temporary-source.mjs'))).toBe(false);
    expect(readFileSync(path.join(remote, 'manual-data.txt'), 'utf8')).toBe('preserve');
  });

  it('bundles unpublished commits so remote Git metadata can name the exact local head', () => {
    const { root, local, remote } = fixture();
    writeFileSync(path.join(local, 'keep.mjs'), 'new commit');
    git(local, 'add', '.');
    git(
      local,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'unpublished',
    );
    const source = snapshot(local, root);
    expect(source.bundle).toBe(true);
    git(remote, 'fetch', '-q', path.join(source.scratch, 'source.bundle'), 'HEAD');
    git(remote, 'reset', '--mixed', source.sha);
    const result = transfer(remote, source);
    expect(result.status, result.stderr).toBe(0);
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remote, encoding: 'utf8' }).trim(),
    ).toBe(source.sha);
    expect(readFileSync(path.join(remote, 'keep.mjs'), 'utf8')).toBe('new commit');
  });
  it('cleans partial source writes on recovery without deleting unrelated blocking data', () => {
    const { root, local, remote } = fixture();
    writeFileSync(path.join(local, 'a-added.swift'), 'partial source');
    writeFileSync(path.join(local, 'z-target.md'), 'wanted file');
    mkdirSync(path.join(remote, 'z-target.md'));
    writeFileSync(path.join(remote, 'z-target.md', 'unrelated.data'), 'preserve');
    expect(transfer(remote, snapshot(local, root)).status).not.toBe(0);
    expect(existsSync(path.join(remote, 'a-added.swift'))).toBe(true);
    rmSync(path.join(local, 'a-added.swift'));
    rmSync(path.join(local, 'z-target.md'));
    const recovered = transfer(remote, snapshot(local, root));
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(existsSync(path.join(remote, 'a-added.swift'))).toBe(false);
    expect(readFileSync(path.join(remote, 'z-target.md', 'unrelated.data'), 'utf8')).toBe(
      'preserve',
    );
  });
  it('handles an uncommitted file-to-directory source change', () => {
    const { root, local, remote } = fixture();
    rmSync(path.join(local, 'keep.mjs'));
    mkdirSync(path.join(local, 'keep.mjs'));
    writeFileSync(path.join(local, 'keep.mjs', 'nested.mjs'), 'nested source');
    const result = transfer(remote, snapshot(local, root));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(remote, 'keep.mjs', 'nested.mjs'), 'utf8')).toBe('nested source');
  });

  it('preserves an unrelated empty directory that obstructs a new source file', () => {
    const { root, local, remote } = fixture();
    writeFileSync(path.join(local, 'new-source.mjs'), 'source');
    mkdirSync(path.join(remote, 'new-source.mjs'));
    const result = transfer(remote, snapshot(local, root));
    expect(result.status).not.toBe(0);
    expect(lstatSync(path.join(remote, 'new-source.mjs')).isDirectory()).toBe(true);
  });

  it('preserves unchanged source mtimes so repeated test runs keep compiler caches warm', () => {
    const { root, local, remote } = fixture();
    const source = snapshot(local, root);
    expect(transfer(remote, source).status).toBe(0);
    const file = path.join(remote, 'keep.mjs');
    const originalTime = new Date('2025-01-01T00:00:00Z');
    utimesSync(file, originalTime, originalTime);
    const result = transfer(remote, source);
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(file).mtimeMs).toBe(originalTime.getTime());
  });
});
