import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts/check-node-modules.mjs');

let scratch;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'futo-node-modules-guard-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runGuard(dir) {
  return spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf8' });
}

describe('node_modules guard', () => {
  it('fails and names the install command when node_modules is absent', () => {
    const result = runGuard(scratch);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules is missing');
    expect(result.stderr).toContain('just install');
  });

  it('passes once node_modules exists', () => {
    mkdirSync(join(scratch, 'node_modules'));

    const result = runGuard(scratch);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('defaults to the repo root, which is installed while the suite runs', () => {
    const result = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });

    expect(result.status).toBe(0);
  });

  it('runs before every other dependency of `just check`', () => {
    const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');
    const check = /^check:(.*)$/m.exec(justfile);

    expect(check?.[1].trim().split(/\s+/)[0]).toBe('check-node-modules');
  });
});
