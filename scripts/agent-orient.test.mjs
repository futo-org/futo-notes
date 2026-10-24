import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

it('counts each papercut ID once after union merges and keeps resolves idempotent', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-orient-log-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  try {
    git('init', '-q');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    );
    const cut = {
      kind: 'cut',
      id: 'pc_000000000001',
      ts: '2026-01-01T00:00:00Z',
      text: 'open',
      severity: 'minor',
      tags: [],
    };
    const closed = { ...cut, id: 'pc_000000000002', text: 'closed' };
    const resolve = { kind: 'resolve', id: closed.id };
    fs.writeFileSync(
      path.join(scratch, '.papercuts.jsonl'),
      [cut, cut, closed, resolve, resolve].map(JSON.stringify).join('\n') + '\n',
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./agent-orient.mjs', import.meta.url)), '--json', '--base', 'HEAD'],
      { cwd: scratch, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).papercuts).toMatchObject({ open: 1, total: 2 });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
