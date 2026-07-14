import { describe, it, expect } from 'vitest';
import { buildFolderTree, flattenFolderTree, type TreeNode, type FolderNode } from './folderTree';
import { isFolderOpen, setFolderOpen } from './folderExpansion.svelte';
import { validateNewFolderName } from './folderOperations';
import { MAX_FOLDER_DEPTH } from '$lib/rules';
import type { NotePreview } from '$shared/types/note';

function note(id: string, mtime = Date.now()): NotePreview {
  return { id, title: id, preview: '', modificationTime: mtime, tags: [] };
}

function flatten(nodes: TreeNode[]): string[] {
  return flattenFolderTree(nodes, isFolderOpen).map((n) =>
    n.type === 'folder'
      ? `D:${n.path}`
      : n.type === 'empty'
        ? `E:${n.parentPath}`
        : `N:${n.note.id}`,
  );
}

function emptyFolder(path: string): FolderNode {
  const components = path.split('/');
  return {
    type: 'folder',
    path,
    name: components[components.length - 1],
    depth: components.length - 1,
    isEmpty: true,
    children: [],
  };
}

describe('buildFolderTree', () => {
  it('returns flat note list when no folders', () => {
    const tree = buildFolderTree([note('a'), note('b')], new Set());
    expect(tree.map((n) => (n.type === 'folder' ? `D:${n.path}` : `N:${n.note.id}`))).toEqual([
      'N:a',
      'N:b',
    ]);
  });

  it('groups notes under shared parent folder', () => {
    const tree = buildFolderTree([note('Specs/foo'), note('Specs/bar'), note('top')], new Set());
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
      expect(new Set(childIds)).toEqual(new Set(['N:Specs/foo', 'N:Specs/bar']));
    }
  });

  it('handles nested paths', () => {
    const tree = buildFolderTree([note('A/B/C/leaf')], new Set());
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
    const notes = [note('zebra'), note('Alpha/foo'), note('Beta/bar'), note('apple')];
    const tree = buildFolderTree(notes, new Set());
    const ids = tree.map((n) => (n.type === 'folder' ? `D:${n.path}` : `N:${n.note.id}`));
    expect(ids).toEqual(['D:Alpha', 'D:Beta', 'N:zebra', 'N:apple']);
  });
});

describe('flattenTree', () => {
  it('respects open/closed state via isFolderOpen', () => {
    const notes = [note('Specs/foo'), note('top')];
    const tree = buildFolderTree(notes, new Set());
    const flat = flatten(tree);
    expect(flat).toContain('D:Specs');
    expect(flat).toContain('N:top');
    expect(flat).not.toContain('N:Specs/foo');
  });

  it('emits an empty placeholder row for an open childless folder', () => {
    const tree: TreeNode[] = [emptyFolder('Empty')];
    try {
      setFolderOpen('Empty', true);
      expect(flatten(tree)).toEqual(['D:Empty', 'E:Empty']);
      const placeholder = flattenFolderTree(tree, isFolderOpen)[1];
      expect(placeholder).toEqual({ type: 'empty', parentPath: 'Empty', depth: 1 });
    } finally {
      setFolderOpen('Empty', false);
    }
  });

  it('emits no placeholder for a CLOSED childless folder', () => {
    expect(flatten([emptyFolder('Empty')])).toEqual(['D:Empty']);
  });

  it('emits no placeholder for an open folder with children', () => {
    const tree = buildFolderTree([note('Specs/foo')], new Set());
    try {
      setFolderOpen('Specs', true);
      expect(flatten(tree)).toEqual(['D:Specs', 'N:Specs/foo']);
    } finally {
      setFolderOpen('Specs', false);
    }
  });

  it('indents the placeholder one level under a nested folder', () => {
    const parent = emptyFolder('a');
    const nested = emptyFolder('a/b');
    parent.children.push(nested);
    try {
      setFolderOpen('a', true);
      setFolderOpen('a/b', true);
      const flat = flattenFolderTree([parent], isFolderOpen);
      expect(flatten([parent])).toEqual(['D:a', 'D:a/b', 'E:a/b']);
      expect(flat[2]).toEqual({ type: 'empty', parentPath: 'a/b', depth: 2 });
    } finally {
      setFolderOpen('a', false);
      setFolderOpen('a/b', false);
    }
  });
});

describe('validateNewFolderName', () => {
  it('returns null for a fresh valid name', () => {
    expect(validateNewFolderName('', 'projects', ['other'])).toBeNull();
  });

  it('rejects a case-insensitive sibling duplicate', () => {
    expect(validateNewFolderName('', 'Projects', ['projects'])).toBe(
      'A folder with this name already exists',
    );
    expect(validateNewFolderName('parent', 'FOO', ['foo', 'bar'])).toMatch(/already exists/);
  });

  it('rejects an empty name', () => {
    expect(validateNewFolderName('', '', [])).toMatch(/empty/i);
  });

  it('rejects names the shared rules refuse (forbidden chars, trailing dots)', () => {
    expect(validateNewFolderName('', 'a/b', [])).not.toBeNull();
    expect(validateNewFolderName('', 'name.', [])).not.toBeNull();
  });

  it('rejects names that exceed the folder depth limit', () => {
    const parent = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => `d${i}`).join('/');
    expect(validateNewFolderName(parent, 'deep', [])).toMatch(/depth/i);
  });
});
