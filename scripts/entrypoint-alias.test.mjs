import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_PORTS_FILE } from './ios-dev-ports.mjs';
import { portsFor } from './lib/slot.mjs';

it.skipIf(process.platform === 'win32').each([
  ['qa-target.mjs', ['status']],
  ['language-catalogs.mjs', []],
  ['lib/sync-server.mjs', ['version']],
  ['ios-remote.mjs', ['--help']],
  ['ios-build-space.mjs', ['.']],
  ['ios-dev-ports.mjs', ['.', 'Debug']],
])('executes read-only %s through a scripts directory alias', (entry, args) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-entry-alias-'));
  try {
    const scripts = fileURLToPath(new URL('./', import.meta.url));
    const alias = path.join(scratch, 'scripts');
    fs.symlinkSync(scripts, alias, 'dir');
    const result = spawnSync(process.execPath, [path.join(alias, entry), ...args], {
      encoding: 'utf8',
      cwd: scratch,
      env: { ...process.env, FUTO_IOS_MIN_FREE_GIB: '0.000001' },
      timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    if (entry === 'ios-dev-ports.mjs') {
      expect(JSON.parse(fs.readFileSync(path.join(scratch, DEV_PORTS_FILE), 'utf8'))).toEqual({
        crashlogPort: portsFor(path.resolve(fileURLToPath(new URL('../', import.meta.url))))
          .crashlog,
      });
    } else expect(result.stdout.trim().length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
