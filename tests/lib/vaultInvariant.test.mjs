import { describe, expect, it } from 'vitest';

import { describeVaultViolations, vaultInvariant } from './vaultInvariant.mjs';

describe('vaultInvariant', () => {
  it('accepts an unchanged vault', () => {
    expect(vaultInvariant(['note.md'], ['note.md'])).toEqual([]);
  });

  it('accepts only explicitly expected creations', () => {
    expect(
      vaultInvariant(
        ['app/Welcome.md'],
        ['app/Welcome.md', 'device/Welcome.md'],
        ['device/Welcome.md'],
      ),
    ).toEqual([]);
  });

  it('reports every unexpected file creation in stable path order', () => {
    expect(vaultInvariant([], ['z.md', 'folder/a.md'], ['z.md'])).toEqual([
      { kind: 'unexpected-creation', path: 'folder/a.md' },
    ]);
  });

  it.each([
    'note (conflict 2026-08-21).md',
    'note (conflict 2026-08-21 2).md',
    'folder/note (conflict deadbeef).md',
    'note (conflict A1B2C3D4).md',
    'note (conflict object).md',
    'note (conflict object-abc123).md',
  ])('reports generated conflict-copy shape %s even when it existed before', (path) => {
    expect(vaultInvariant([path], [path], [path])).toEqual([{ kind: 'conflict-copy', path }]);
  });

  it('does not mistake a user title mentioning conflict for a generated copy', () => {
    expect(
      vaultInvariant(
        ['plan (conflict resolution).md'],
        ['plan (conflict resolution).md', 'notes (conflict draft).md'],
        ['notes (conflict draft).md'],
      ),
    ).toEqual([]);
  });

  it('reports a newly created conflict copy as both unsafe facts', () => {
    expect(vaultInvariant(['note.md'], ['note.md', 'note (conflict 2026-08-21).md'])).toEqual([
      { kind: 'conflict-copy', path: 'note (conflict 2026-08-21).md' },
      { kind: 'unexpected-creation', path: 'note (conflict 2026-08-21).md' },
    ]);
  });
});

describe('describeVaultViolations', () => {
  it('renders the violated invariant as an actionable story failure', () => {
    expect(
      describeVaultViolations([
        { kind: 'conflict-copy', path: 'note (conflict 2026-08-21).md' },
        { kind: 'unexpected-creation', path: 'other.md' },
      ]),
    ).toBe(
      'generated conflict copy: note (conflict 2026-08-21).md; unexpected file creation: other.md',
    );
  });
});
