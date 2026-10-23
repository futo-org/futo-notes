import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

it('snapshots staged, unstaged and untracked source without touching the index or stash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redproof-snapshot-'));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
    fs.writeFileSync(path.join(root, 'partial.txt'), 'base\n');
    fs.writeFileSync(path.join(root, 'deleted.txt'), 'base\n');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'fixture',
    ]);
    git(['update-ref', 'refs/stash', 'HEAD']);
    fs.writeFileSync(path.join(root, 'partial.txt'), 'staged\n');
    git(['add', 'partial.txt']);
    fs.writeFileSync(path.join(root, 'partial.txt'), 'worktree\n');
    fs.unlinkSync(path.join(root, 'deleted.txt'));
    fs.writeFileSync(path.join(root, 'new source\nfile.mjs'), 'new source\n');
    fs.writeFileSync(path.join(root, 'new-executable'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync('partial.txt', path.join(root, 'new-link'));
    fs.mkdirSync(path.join(root, 'ignored'));
    fs.writeFileSync(path.join(root, 'ignored/private.txt'), 'ignored\n');

    // The copy makes even the pre-fix implementation resolve its ROOT to this
    // disposable repository; the real checkout's index and stash stay out of reach.
    fs.mkdirSync(path.join(root, 'scripts/gate-redproofs'), { recursive: true });
    const modulePath = path.join(root, 'scripts/gate-redproofs/worktree.mjs');
    fs.copyFileSync(new URL('./worktree.mjs', import.meta.url), modulePath);
    const { resolveBase } = await import(pathToFileURL(modulePath).href);
    const statusBefore = git(['status', '--porcelain=v1', '-z']);
    const indexBefore = fs.readFileSync(path.join(root, '.git/index'));
    const stashBefore = git(['rev-parse', 'refs/stash']);
    const base = resolveBase();
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(indexBefore);
    expect(git(['status', '--porcelain=v1', '-z'])).toBe(statusBefore);
    expect(git(['rev-parse', 'refs/stash'])).toBe(stashBefore);
    expect(git(['show', `${base.rev}:partial.txt`])).toBe('worktree\n');
    expect(git(['show', `${base.rev}:new source\nfile.mjs`])).toBe('new source\n');
    expect(git(['ls-tree', base.rev, 'new-link'])).toMatch(/^120000 blob/);
    expect(git(['show', `${base.rev}:new-link`])).toBe('partial.txt');
    expect(git(['ls-tree', base.rev, 'new-executable'])).toMatch(/^100755 blob/);
    expect(git(['ls-tree', base.rev, 'deleted.txt', 'ignored/private.txt'])).toBe('');
    expect(fs.readlinkSync(path.join(root, 'new-link'))).toBe('partial.txt');
    expect(fs.readFileSync(path.join(root, 'new source\nfile.mjs'), 'utf8')).toBe('new source\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
