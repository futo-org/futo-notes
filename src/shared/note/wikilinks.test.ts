import { describe, it, expect } from 'vitest';
import {
  buildWikilinkIndex,
  shortestUniqueSuffix,
  resolveWikilink,
  findWikilinks,
  rewriteWikilinks,
  noteIdLeaf,
} from './wikilinks';
import conformance from '@/tests/conformance/wikilinks.json';

describe('noteIdLeaf', () => {
  it('returns leaf component', () => {
    expect(noteIdLeaf('foo')).toBe('foo');
    expect(noteIdLeaf('a/b/foo')).toBe('foo');
  });
});

describe('shortestUniqueSuffix', () => {
  it('returns leaf when leaf is unique', () => {
    const ids = ['A/Specs/foo', 'B/bar', 'baz'];
    expect(shortestUniqueSuffix('A/Specs/foo', ids)).toBe('foo');
    expect(shortestUniqueSuffix('B/bar', ids)).toBe('bar');
    expect(shortestUniqueSuffix('baz', ids)).toBe('baz');
  });

  it('extends suffix until unique (spec example)', () => {
    const ids = ['A/B/grocery', 'A/C/grocery', 'D/grocery'];
    expect(shortestUniqueSuffix('A/B/grocery', ids)).toBe('B/grocery');
    expect(shortestUniqueSuffix('A/C/grocery', ids)).toBe('C/grocery');
    expect(shortestUniqueSuffix('D/grocery', ids)).toBe('D/grocery');
  });

  it('falls back to full ID when no shorter suffix is unique', () => {
    const ids = ['x/A/B/grocery', 'A/B/grocery'];
    expect(shortestUniqueSuffix('x/A/B/grocery', ids)).toBe('x/A/B/grocery');
  });

  it('handles single-note vault', () => {
    expect(shortestUniqueSuffix('foo', ['foo'])).toBe('foo');
    expect(shortestUniqueSuffix('a/foo', ['a/foo'])).toBe('foo');
  });
});

describe('resolveWikilink', () => {
  it('resolves exact full path', () => {
    const ids = ['Specs/folder', 'A/B/foo'];
    expect(resolveWikilink('Specs/folder', ids)).toBe('Specs/folder');
    expect(resolveWikilink('A/B/foo', ids)).toBe('A/B/foo');
  });

  it('resolves a unique bare filename (legacy)', () => {
    const ids = ['Specs/folder-support', 'A/foo'];
    expect(resolveWikilink('folder-support', ids)).toBe('Specs/folder-support');
    expect(resolveWikilink('foo', ids)).toBe('A/foo');
  });

  it('returns null for ambiguous bare filename', () => {
    const ids = ['A/grocery', 'B/grocery'];
    expect(resolveWikilink('grocery', ids)).toBeNull();
  });

  it('returns null for absent target', () => {
    const ids = ['Specs/folder'];
    expect(resolveWikilink('does-not-exist', ids)).toBeNull();
  });

  it('resolves a unique multi-component path-suffix', () => {
    const ids = ['x/Specs/folder', 'Other/y'];
    expect(resolveWikilink('Specs/folder', ids)).toBe('x/Specs/folder');
  });

  it('returns null for ambiguous multi-component suffix', () => {
    const ids = ['x/Specs/folder', 'y/Specs/folder'];
    expect(resolveWikilink('Specs/folder', ids)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveWikilink('', ['foo'])).toBeNull();
  });
});

describe('buildWikilinkIndex', () => {
  // The index is an accelerator for two rules ported bit-for-bit to Rust, so it
  // is held to their answers rather than to expectations written here.
  const groups = conformance.groups as Array<{
    op: string;
    cases: Array<{ input: Record<string, string | string[]> }>;
  }>;

  it('answers every resolveWikilink conformance case identically', () => {
    const cases = groups.find((group) => group.op === 'resolveWikilink')!.cases;
    expect(cases.length).toBeGreaterThan(0);
    for (const { input } of cases) {
      const allIds = input.allIds as string[];
      const target = input.target as string;
      expect(buildWikilinkIndex(allIds).resolve(target)).toEqual(resolveWikilink(target, allIds));
    }
  });

  it('answers every shortestUniqueSuffix conformance case identically', () => {
    const cases = groups.find((group) => group.op === 'shortestUniqueSuffix')!.cases;
    expect(cases.length).toBeGreaterThan(0);
    for (const { input } of cases) {
      const allIds = input.allIds as string[];
      const targetId = input.targetId as string;
      expect(buildWikilinkIndex(allIds).displaySuffix(targetId)).toBe(
        shortestUniqueSuffix(targetId, allIds),
      );
    }
  });

  it('agrees with both rules across a vault of colliding paths', () => {
    const ids = [
      'grocery',
      'A/grocery',
      'B/grocery',
      'A/B/grocery',
      'x/A/B/grocery',
      'Specs/folder',
      'x/Specs/folder',
      'lone',
      'Deep/a/b/c/leaf',
    ];
    const index = buildWikilinkIndex(ids);
    const targets = [...ids, '', 'absent', 'b/c/leaf', 'c/leaf', 'folder', 'B/grocery'];
    for (const target of targets) {
      expect(index.resolve(target)).toEqual(resolveWikilink(target, ids));
    }
    for (const id of ids) {
      expect(index.displaySuffix(id)).toBe(shortestUniqueSuffix(id, ids));
    }
  });

  it('agrees with both rules when the vault lists the same id twice', () => {
    const ids = ['dup/x', 'dup/x', 'b/a/y', 'b/a/y', 'lone'];
    const index = buildWikilinkIndex(ids);
    for (const target of ['x', 'a/y', 'dup/x', 'lone', 'y']) {
      expect(index.resolve(target)).toEqual(resolveWikilink(target, ids));
    }
    for (const id of ids) {
      expect(index.displaySuffix(id)).toBe(shortestUniqueSuffix(id, ids));
    }
  });

  it('falls back to the unindexed rule for an id the vault does not hold', () => {
    const ids = ['A/grocery', 'B/grocery'];
    expect(buildWikilinkIndex(ids).displaySuffix('C/grocery')).toBe(
      shortestUniqueSuffix('C/grocery', ids),
    );
  });

  it('reads the note list once to build and never again to look up', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `folder${i % 20}/note ${i}`);
    let reads = 0;
    const counted = {
      *[Symbol.iterator]() {
        for (const id of ids) {
          reads += 1;
          yield id;
        }
      },
    };

    const index = buildWikilinkIndex(counted);
    expect(reads).toBe(ids.length);

    reads = 0;
    for (const id of ids) {
      index.resolve(id);
      index.resolve(`note ${id}`);
      index.displaySuffix(id);
    }
    expect(reads).toBe(0);
  });
});

describe('findWikilinks', () => {
  it('finds simple wikilinks', () => {
    const text = 'see [[foo]] and [[bar]] for more.';
    const occ = findWikilinks(text);
    expect(occ).toHaveLength(2);
    expect(occ[0].target).toBe('foo');
    expect(occ[1].target).toBe('bar');
    expect(text.slice(occ[0].start, occ[0].end)).toBe('[[foo]]');
  });

  it('handles full-path targets', () => {
    const text = 'check [[Specs/folder-support]] please';
    const occ = findWikilinks(text);
    expect(occ).toHaveLength(1);
    expect(occ[0].target).toBe('Specs/folder-support');
  });

  it('returns empty for no wikilinks', () => {
    expect(findWikilinks('plain text only')).toEqual([]);
  });
});

describe('rewriteWikilinks', () => {
  it('rewrites full-path target on rename', () => {
    const ids = ['Specs/folder-support', 'Other/foo'];
    const text = 'see [[Specs/folder-support]] for details';
    const result = rewriteWikilinks(text, 'Specs/folder-support', 'Specs/folders', ids);
    expect(result.text).toBe('see [[Specs/folders]] for details');
    expect(result.rewrites).toBe(1);
  });

  it('rewrites legacy bare filename when unique', () => {
    const ids = ['Specs/folder-support', 'Other/foo'];
    const text = 'see [[folder-support]] please';
    const result = rewriteWikilinks(text, 'Specs/folder-support', 'Specs/folders', ids);
    expect(result.text).toBe('see [[Specs/folders]] please');
    expect(result.rewrites).toBe(1);
  });

  it('does not rewrite ambiguous bare filename', () => {
    const ids = ['A/grocery', 'B/grocery'];
    const text = 'shop [[grocery]] today';
    const result = rewriteWikilinks(text, 'A/grocery', 'A/store', ids);
    expect(result.text).toBe('shop [[grocery]] today');
    expect(result.rewrites).toBe(0);
  });

  it('does not touch unrelated wikilinks', () => {
    const ids = ['Specs/folder-support', 'Other/foo'];
    const text = 'check [[Other/foo]] not [[Specs/folder-support]]';
    const result = rewriteWikilinks(text, 'Other/foo', 'Other/bar', ids);
    expect(result.text).toBe('check [[Other/bar]] not [[Specs/folder-support]]');
    expect(result.rewrites).toBe(1);
  });

  it('handles multiple occurrences', () => {
    const ids = ['Specs/folder-support'];
    const text = '[[folder-support]] and again [[folder-support]]';
    const result = rewriteWikilinks(text, 'Specs/folder-support', 'Specs/folders', ids);
    expect(result.text).toBe('[[Specs/folders]] and again [[Specs/folders]]');
    expect(result.rewrites).toBe(2);
  });

  it('returns text unchanged when no rewrites apply', () => {
    const ids = ['Specs/folder-support'];
    const text = 'plain text [[Other/foo]] only';
    const result = rewriteWikilinks(text, 'Specs/folder-support', 'Specs/folders', ids);
    expect(result.text).toBe(text);
    expect(result.rewrites).toBe(0);
  });

  it('handles a folder rename that moves multiple notes', () => {
    const ids = ['Specs/a', 'Specs/b', 'Other/c'];
    const text = 'see [[Specs/a]] and [[Specs/b]] but not [[Other/c]]';
    let { text: out } = rewriteWikilinks(text, 'Specs/a', 'Designs/a', ids);
    out = rewriteWikilinks(out, 'Specs/b', 'Designs/b', ids).text;
    expect(out).toBe('see [[Designs/a]] and [[Designs/b]] but not [[Other/c]]');
  });
});
