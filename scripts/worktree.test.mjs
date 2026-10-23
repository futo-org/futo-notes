import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function withRemoteRepo(check) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-wt-refs-'));
  const repo = path.join(scratch, 'notes');
  const remote = path.join(scratch, 'origin.git');
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const create = (base) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./worktree.mjs', import.meta.url)),
        'new',
        'review',
        '--base',
        base,
        '--no-install',
        '--no-target',
      ],
      { cwd: repo, encoding: 'utf8', env },
    );
  const commit = () => {
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  const expectCreated = (base, head) => {
    const result = create(base);
    expect(result.status, result.stderr).toBe(0);
    expect(git('-C', path.join(scratch, 'notes-review'), 'rev-parse', 'HEAD')).toBe(head);
  };
  try {
    git('init', '-b', 'main');
    git('init', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    const initial = commit();
    git('push', 'origin', 'main');
    check({ git, create, commit, expectCreated, initial, remote, scratch });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

it('creates a worktree from an already-fetched merge-request ref', () => {
  withRemoteRepo(({ git, expectCreated, initial }) => {
    git('push', 'origin', 'HEAD:refs/merge-requests/448/head');
    git('fetch', 'origin', 'refs/merge-requests/448/head:refs/remotes/origin/mr-448');
    expectCreated('origin/mr-448', initial);
  });
});

it('creates from an explicit local remote-tracking ref while offline', () => {
  withRemoteRepo(({ git, expectCreated, initial, scratch }) => {
    git('remote', 'set-url', 'origin', path.join(scratch, 'missing.git'));
    expectCreated('refs/remotes/origin/main', initial);
  });
});

it.each(['claude/topic', 'origin/topic', 'refs/heads/claude/topic'])(
  'creates a worktree from the local branch %s',
  (base) => {
    withRemoteRepo(({ git, expectCreated, initial }) => {
      git('branch', base.replace(/^refs\/heads\//, ''));
      expectCreated(base, initial);
    });
  },
);

it.each(['origin/main', 'origin/mr-448'])(
  'refreshes a real remote branch %s before creating',
  (base) => {
    withRemoteRepo(({ git, commit, expectCreated }) => {
      const branch = base.slice('origin/'.length);
      git('push', 'origin', `HEAD:refs/heads/${branch}`);
      const latest = commit();
      git('push', 'origin', `HEAD:refs/heads/${branch}`);
      // Restore the tracking ref to prove that the CLI refreshes it.
      git('update-ref', `refs/remotes/${base}`, 'HEAD~1');
      expectCreated(base, latest);
    });
  },
);

it('does not create from a stale tracking ref when its remote branch was deleted', () => {
  withRemoteRepo(({ git, create, scratch }) => {
    git('push', 'origin', '--delete', 'main');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = create('origin/main');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refs\/heads\/main|remote ref main/);
    expect(fs.existsSync(path.join(scratch, 'notes-review'))).toBe(false);
  });
});

it('does not create from a stale tracking ref when the remote cannot be reached', () => {
  withRemoteRepo(({ git, create, scratch }) => {
    git('remote', 'set-url', 'origin', path.join(scratch, 'missing.git'));
    const result = create('origin/main');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not appear to be a git repository');
    expect(fs.existsSync(path.join(scratch, 'notes-review'))).toBe(false);
  });
});

it('fails when fetching a remote branch fails after a successful probe', () => {
  withRemoteRepo(({ git, create, scratch }) => {
    const uploadPack = path.join(scratch, 'upload-pack');
    fs.writeFileSync(
      uploadPack,
      '#!/bin/sh\n' +
        'if [ -f "$0.used" ]; then echo "fixture fetch failed" >&2; exit 1; fi\n' +
        'touch "$0.used"\n' +
        'exec git-upload-pack "$@"\n',
      { mode: 0o755 },
    );
    git('config', 'remote.origin.uploadpack', uploadPack);
    const result = create('origin/main');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fetching origin/main');
    expect(result.stderr).toContain('fixture fetch failed');
    expect(fs.existsSync(path.join(scratch, 'notes-review'))).toBe(false);
  });
});
