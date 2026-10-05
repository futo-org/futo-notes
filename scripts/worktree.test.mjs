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
