/**
 * Tests for `folders.svelte.ts` tree builder.
 *
 * The reactive state (open folders, drag-hover) is exercised by the
 * Playwright tests; this file focuses on the pure tree-building logic
 * that consumes a `NotePreview[]` and emits the rendered tree.
 */

import { describe, it, expect } from 'vitest';
import { buildFolderTree, flattenTree, type TreeNode } from './folders.svelte';
import type { NotePreview } from '../types';

function note(id: string, mtime = Date.now()): NotePreview {
  return { id, title: id, preview: '', modificationTime: mtime, tags: [] };
}

function flatten(nodes: TreeNode[]): string[] {
  return flattenTree(nodes).map((n) =>
    n.type === 'folder' ? `D:${n.path}` : `N:${n.note.id}`,
  );
}

describe('buildFolderTree', () => {
  it('returns flat note list when no folders', () => {
    const tree = buildFolderTree([note('a'), note('b')]);
    expect(tree.map((n) => (n.type === 'folder' ? `D:${n.path}` : `N:${n.note.id}`))).toEqual([
      'N:a',
      'N:b',
    ]);
  });

  it('groups notes under shared parent folder', () => {
    const tree = buildFolderTree([note('Specs/foo'), note('Specs/bar'), note('top')]);
    // Folders alphabetically before notes at the same level.
    expect(tree.map((n) => (n.type === 'folder' ? `D:${n.path}` : `N:${n.note.id}`))).toEqual([
      'D:Specs',
      'N:top',
    ]);
    const specs = tree[0];
    expect(specs.type).toBe('folder');
    if (specs.type === 'folder') {
      const childIds = specs.children.map((c) =>
        c.type === 'folder' ? `D:${c.path}` : `N:${c.note.id}`,
      );
      // Both children are notes at the same level — input order preserved
      expect(new Set(childIds)).toEqual(new Set(['N:Specs/foo', 'N:Specs/bar']));
    }
  });

  it('handles nested paths', () => {
    const tree = buildFolderTree([note('A/B/C/leaf')]);
    expect(tree.length).toBe(1);
    const a = tree[0];
    expect(a.type).toBe('folder');
    if (a.type === 'folder') {
      expect(a.path).toBe('A');
      expect(a.children.length).toBe(1);
      const b = a.children[0];
      expect(b.type).toBe('folder');
      if (b.type === 'folder') {
        expect(b.path).toBe('A/B');
        expect(b.children.length).toBe(1);
        const c = b.children[0];
        expect(c.type).toBe('folder');
        if (c.type === 'folder') {
          expect(c.path).toBe('A/B/C');
          expect(c.children[0].type).toBe('note');
          if (c.children[0].type === 'note') {
            expect(c.children[0].note.id).toBe('A/B/C/leaf');
          }
        }
      }
    }
  });

  it('sorts folders alphabetically and folders-before-notes', () => {
    const notes = [
      note('zebra'),
      note('Alpha/foo'),
      note('Beta/bar'),
      note('apple'),
    ];
    const tree = buildFolderTree(notes);
    const ids = tree.map((n) => (n.type === 'folder' ? `D:${n.path}` : `N:${n.note.id}`));
    // Folders first (alphabetic), then notes preserving input order
    expect(ids).toEqual(['D:Alpha', 'D:Beta', 'N:zebra', 'N:apple']);
  });
});

describe('flattenTree', () => {
  it('respects open/closed state via isFolderOpen', () => {
    const notes = [note('Specs/foo'), note('top')];
    const tree = buildFolderTree(notes);
    // Default open-folders set is empty; closed folders contribute the
    // folder row only, no children.
    const flat = flatten(tree);
    expect(flat).toContain('D:Specs');
    expect(flat).toContain('N:top');
    expect(flat).not.toContain('N:Specs/foo');
  });
});
