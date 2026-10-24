import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

it.skipIf(process.platform === 'win32').each([
  ['qa-target.mjs', ['status']],
  ['language-catalogs.mjs', []],
  ['lib/sync-server.mjs', ['version']],
])('executes read-only %s through a scripts directory alias', (entry, args) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-entry-alias-'));
  try {
    const scripts = fileURLToPath(new URL('./', import.meta.url));
    const alias = path.join(scratch, 'scripts');
    fs.symlinkSync(scripts, alias, 'dir');
    const result = spawnSync(process.execPath, [path.join(alias, entry), ...args], {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
