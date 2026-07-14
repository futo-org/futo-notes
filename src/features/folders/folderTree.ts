import type { NotePreview } from '$shared/types/note';

export interface FolderNode {
  type: 'folder';
  path: string;
  name: string;
  depth: number;
  isEmpty: boolean;
  children: TreeNode[];
}

export interface NoteNode {
  type: 'note';
  note: NotePreview;
  depth: number;
  parentPath: string;
}

export type TreeNode = FolderNode | NoteNode;

export interface EmptyFolderPlaceholderNode {
  type: 'empty';
  parentPath: string;
  depth: number;
}

export type FlatNode = TreeNode | EmptyFolderPlaceholderNode;

function sortTreeLevel(nodes: TreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.type === 'folder' && right.type === 'note') return -1;
    if (left.type === 'note' && right.type === 'folder') return 1;
    if (left.type === 'folder' && right.type === 'folder') {
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
    return 0;
  });
  nodes.forEach((node) => {
    if (node.type === 'folder') sortTreeLevel(node.children);
  });
}

export function buildFolderTree(
  notes: NotePreview[],
  emptyFolderPaths: ReadonlySet<string>,
): TreeNode[] {
  const folders = new Map<string, FolderNode>();
  const roots: TreeNode[] = [];
  const ensureFolder = (path: string, isEmpty: boolean): FolderNode => {
    const existing = folders.get(path);
    if (existing) {
      if (!isEmpty) existing.isEmpty = false;
      return existing;
    }
    const components = path.split('/');
    const folder: FolderNode = {
      type: 'folder',
      path,
      name: components[components.length - 1] ?? path,
      depth: components.length - 1,
      isEmpty,
      children: [],
    };
    folders.set(path, folder);
    return folder;
  };

  for (const path of emptyFolderPaths) {
    const components = path.split('/');
    for (let index = 1; index <= components.length; index++) {
      ensureFolder(components.slice(0, index).join('/'), true);
    }
  }

  const seenNoteIds = new Set<string>();
  for (const note of notes) {
    if (seenNoteIds.has(note.id)) continue;
    seenNoteIds.add(note.id);
    const components = note.id.split('/');
    let parent: FolderNode | null = null;

    for (let index = 1; index < components.length; index++) {
      const folder = ensureFolder(components.slice(0, index).join('/'), false);
      const siblings: TreeNode[] = parent ? parent.children : roots;
      if (!siblings.includes(folder)) siblings.push(folder);
      parent = folder;
    }

    const noteNode: NoteNode = {
      type: 'note',
      note,
      depth: components.length - 1,
      parentPath: parent?.path ?? '',
    };
    (parent?.children ?? roots).push(noteNode);
  }

  for (const folder of folders.values()) {
    if (folder.depth === 0) {
      if (!roots.includes(folder)) roots.push(folder);
      continue;
    }
    const parentPath = folder.path.split('/').slice(0, -1).join('/');
    const parent = folders.get(parentPath);
    if (parent && !parent.children.includes(folder)) parent.children.push(folder);
  }

  sortTreeLevel(roots);
  return roots;
}

export function flattenFolderTree(
  tree: TreeNode[],
  isOpen: (path: string) => boolean = () => false,
): FlatNode[] {
  const flattened: FlatNode[] = [];
  const visit = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      flattened.push(node);
      if (node.type !== 'folder' || !isOpen(node.path)) continue;
      if (node.children.length === 0) {
        flattened.push({ type: 'empty', parentPath: node.path, depth: node.depth + 1 });
      } else visit(node.children);
    }
  };
  visit(tree);
  return flattened;
}
