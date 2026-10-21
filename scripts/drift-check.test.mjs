import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findMissingScanDirs, loadRegistry, shouldSkipDriftDirectory } from './drift-check.mjs';

// Regression coverage: `walk()` used to silently return zero files for a
// scan.dirs entry that doesn't exist (`if (!fs.existsSync(dir)) return out;`),
// so a typo'd or moved directory in scripts/drift-registry.json's "scan.dirs"
// scanned nothing and the deny-by-default gate reported OK — exactly how a
// moved directory switches the duplicate detector off silently.

describe('findMissingScanDirs', () => {
  it('flags a registered scan dir that does not exist', () => {
    const dirExists = (d) => d !== 'src/moved-away';
    expect(findMissingScanDirs(['src', 'src/moved-away', 'crates'], dirExists)).toEqual([
      'src/moved-away',
    ]);
  });

  it('reports nothing when every registered scan dir exists — reproduces the pre-fix silent pass', () => {
    // Before the fix, ANY dirs list (even all-missing) produced zero
    // findings because walk() just returned an empty array per dir. This
    // asserts the happy path stays clean, not that it stays silent when
    // something is actually wrong (covered by the test above).
    const dirExists = () => true;
    expect(findMissingScanDirs(['src', 'crates'], dirExists)).toEqual([]);
  });
});

describe('shouldSkipDriftDirectory', () => {
  it('skips a nested git worktree whose .git metadata is a pointer file', () => {
    const exists = (path) => path === '/repo/wtbase/.git';
    expect(shouldSkipDriftDirectory('wtbase', '/repo/wtbase', exists)).toBe(true);
  });

  it('keeps an ordinary source directory in the registry scan', () => {
    expect(shouldSkipDriftDirectory('src', '/repo/src', () => false)).toBe(false);
  });
});

describe('loadRegistry', () => {
  it('loads every listed concept file and reports one the index does not list', () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-registry-'));
    try {
      mkdirSync(join(root, 'scripts/drift-registry'), { recursive: true });
      writeFileSync(
        join(root, 'scripts/drift-registry.json'),
        JSON.stringify({ entryFiles: ['scripts/drift-registry/listed.json'] }),
      );
      writeFileSync(join(root, 'scripts/drift-registry/listed.json'), '{"concept":"listed"}');
      writeFileSync(join(root, 'scripts/drift-registry/forgotten.json'), '{"concept":"forgotten"}');
      expect(loadRegistry(root)).toEqual({
        entries: [{ concept: 'listed' }],
        unlisted: ['scripts/drift-registry/forgotten.json'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
