import { describe, expect, it } from 'vitest';

import { findMissingScanDirs, isScannablePath } from './drift-check.mjs';

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

// Regression coverage for the nested-worktree false red: the scan used to walk
// the filesystem with readdirSync, which descends into a nested git worktree or
// sibling checkout (`wtbase/`) — a whole second copy of this repo, so every
// registered copy reappeared there as an "unregistered occurrence" and
// `just check` / `just arch-gate` failed on a clean tree. Reported five times
// (pc_b0a157cde913, pc_632539af6861, pc_5eb5f10acb22, pc_71f2641a8727,
// pc_4718f591a08b). Enumeration now goes through `git ls-files`, which does not
// recurse into a nested repository.

describe('isScannablePath', () => {
  const exts = ['.mjs', '.ts'];

  it('keeps a normal source file under the scanned dir', () => {
    expect(isScannablePath('scripts/lib/slot.mjs', '.', exts)).toBe(true);
  });

  it('skips a SKIP_DIRS segment anywhere in the path', () => {
    expect(isScannablePath('src/node_modules/x/y.mjs', '.', exts)).toBe(false);
    expect(isScannablePath('apps/ios/Sources/Generated/x.ts', '.', exts)).toBe(false);
  });

  it('skips dot-directories when scanning the repo root, as the old walk did', () => {
    expect(isScannablePath('.claude/agents/app-qa.mjs', '.', exts)).toBe(false);
  });

  it('still scans an explicitly-registered dot-directory', () => {
    // '.claude' is a real scan.dirs entry; the dot-skip must not swallow the
    // requested directory itself, only dot-dirs BELOW it.
    expect(isScannablePath('.claude/agents/app-qa.mjs', '.claude', exts)).toBe(true);
    expect(isScannablePath('.claude/worktrees/w/x.mjs', '.claude', exts)).toBe(false);
  });

  it('ignores a file whose extension is not requested', () => {
    expect(isScannablePath('scripts/lib/slot.swift', '.', exts)).toBe(false);
  });
});
