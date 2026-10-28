import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dropMissingPaths } from './format.mjs';

describe('dropMissingPaths', () => {
  it('keeps files that exist and drops deleted-but-unstaged paths', () => {
    // A file deleted in the working tree is still listed by ls-files --cached
    // until the deletion is staged; Prettier errors on the missing path, which
    // is what this regression pins.
    const existing = new Set(['src/a.ts', 'scripts/b.mjs']);
    const files = ['src/a.ts', 'src/deleted.ts', 'scripts/b.mjs', 'src/renamed-away.svelte'];

    expect(dropMissingPaths(files, (f) => existing.has(f))).toEqual(['src/a.ts', 'scripts/b.mjs']);
  });
});

it('explains how to install the missing local formatter before launching Node', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'format-dependencies-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(
      new URL('./format.mjs', import.meta.url),
      path.join(root, 'scripts/format.mjs'),
    );
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'scripts/format.mjs'], { cwd: root });
    const result = spawnSync(process.execPath, ['scripts/format.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('just install');
    expect(result.stderr).toContain('Prettier');
    expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
