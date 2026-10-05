import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyWorktree, cloneTargetCommand, parseWorktrees, siblingPath } from './worktree.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-08T12:00:00Z');
const ctx = { now, idleDays: 30, primary: '/dev/futo-notes', current: '/dev/futo-notes-agent-dx' };

const clean = (over) => ({
  path: '/dev/futo-notes-x',
  head: 'abc',
  branch: 'feat/x',
  detached: false,
  bare: false,
  missing: false,
  dirty: 0,
  merged: false,
  lastCommitMs: now - 2 * DAY,
  ...over,
});

it('creates a worktree from a bare name with the same flags as new', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-wt-'));
  const repo = path.join(scratch, 'notes');
  fs.mkdirSync(repo);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./worktree.mjs', import.meta.url)), ...args],
      { cwd: repo, encoding: 'utf8' },
    );
  try {
    git(['init', '-b', 'main']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    for (const args of [['icons'], ['new', 'explicit']]) {
      const name = args.at(-1);
      const result = run(
        ...args,
        '--base',
        'main',
        '--branch',
        `feat/${name}`,
        '--no-install',
        '--no-target',
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(scratch, `notes-${name}`, '.git'))).toBe(true);
      expect(git(['worktree', 'list', '--porcelain'])).toContain(`branch refs/heads/feat/${name}`);
    }
    expect(run('list').status).toBe(0);
    expect(run('gc', '--no-fetch').status).toBe(0);
    expect(run().status).toBe(2);
    expect(run('--bogus').status).not.toBe(0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

describe('parseWorktrees', () => {
  it('reads path, head, branch and detached state', () => {
    const wts = parseWorktrees(
      [
        'worktree /dev/futo-notes',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /dev/futo-notes-x',
        'HEAD bbb',
        'detached',
        '',
      ].join('\n'),
    );
    expect(wts).toEqual([
      { path: '/dev/futo-notes', head: 'aaa', branch: 'main', detached: false, bare: false },
      { path: '/dev/futo-notes-x', head: 'bbb', branch: null, detached: true, bare: false },
    ]);
  });
});

describe('siblingPath', () => {
  it('names the checkout ../<repo>-<name> and rejects unsafe names', () => {
    expect(siblingPath('/dev/futo-notes', 'agent-dx')).toBe('/dev/futo-notes-agent-dx');
    expect(() => siblingPath('/dev/futo-notes', '../x')).toThrow();
    expect(() => siblingPath('/dev/futo-notes', '-flag')).toThrow();
  });
});

describe('cloneTargetCommand', () => {
  it('reflinks on btrfs/APFS and refuses to full-copy elsewhere', () => {
    expect(cloneTargetCommand('linux', '/a/target', '/b/target')).toEqual([
      'cp',
      ['-R', '--reflink=always', '/a/target', '/b/target'],
    ]);
    expect(cloneTargetCommand('darwin', '/a/target', '/b/target')).toEqual([
      'cp',
      ['-Rc', '/a/target', '/b/target'],
    ]);
    expect(cloneTargetCommand('win32', '/a', '/b')).toBeNull();
  });
});

describe('classifyWorktree — the gc decision', () => {
  // Red proof for the one rule that protects work: a dirty tree is never a
  // candidate, whatever else is true of it.
  it('NEVER lists a worktree with uncommitted changes, even when merged and idle', () => {
    const verdict = classifyWorktree(
      clean({ dirty: 3, merged: true, lastCommitMs: now - 400 * DAY }),
      ctx,
    );
    expect(verdict.candidate).toBe(false);
    expect(verdict.protectedBy).toBe('dirty');
  });

  it('never lists the primary checkout or the one you are standing in', () => {
    expect(
      classifyWorktree(clean({ path: '/dev/futo-notes', merged: true }), ctx).protectedBy,
    ).toBe('primary');
    expect(
      classifyWorktree(clean({ path: '/dev/futo-notes-agent-dx', merged: true }), ctx).protectedBy,
    ).toBe('current');
  });

  it('lists a clean merged worktree and a clean idle one, with the reason', () => {
    expect(classifyWorktree(clean({ merged: true }), ctx)).toEqual({
      candidate: true,
      reason: 'merged',
      protectedBy: null,
    });
    const idle = classifyWorktree(clean({ lastCommitMs: now - 45 * DAY }), ctx);
    expect(idle.candidate).toBe(true);
    expect(idle.reason).toBe('idle 45d');
  });

  it('keeps a clean, recent, unmerged worktree', () => {
    expect(classifyWorktree(clean(), ctx)).toEqual({
      candidate: false,
      reason: null,
      protectedBy: null,
    });
  });

  it('lists a worktree whose directory is gone (prune leftovers)', () => {
    expect(classifyWorktree(clean({ missing: true }), ctx).reason).toBe('missing');
  });
});
