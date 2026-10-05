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

  it('passes every path through the existence predicate', () => {
    const seen = [];
    dropMissingPaths(['x.ts'], (f) => {
      seen.push(f);
      return true;
    });
    expect(seen).toEqual(['x.ts']);
  });
});
