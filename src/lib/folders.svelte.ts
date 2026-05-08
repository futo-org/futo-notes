/**
 * Folder state and tree building.
 *
 * - Empty folders exist on disk locally but do not sync. They live
 *   in `emptyFolders` until the user adds content.
 * - Open / closed state is local-only (not synced) and persisted
 *   to localStorage.
 * - The folder tree is derived from every note's path + the empty
 *   folder set + every directory listed by the platform FS.
 */

import type { NotePreview } from '../types';
import { getFS, isTauri } from './platform';
import {
  hasCaseInsensitiveSiblingCollision,
  isValidFolderName,
  MAX_FOLDER_DEPTH,
  pathDepth,
  validateFolderName,
} from '@futo-notes/shared';

// ── Reactive state ────────────────────────────────────────────────────

/** Open folders by relative path. Persisted to localStorage so the tree
 *  state survives reloads. Local-only — not synced. */
let openFolders = $state<Set<string>>(loadOpenFoldersFromStorage());

/** Folders that exist on disk but have no descendant notes. Tracked in
 *  memory and refreshed from `fs.listFolders()` on bootstrap and after
 *  folder operations. */
let emptyFolders = $state<Set<string>>(new Set());

/** Pending hover-expanded folders during drag-and-drop. Reverts on drop
 *  per spec: "The drag must not persist this expand state". */
let dragHoverExpanded = $state<Set<string>>(new Set());

const OPEN_FOLDERS_KEY = 'futo-notes:openFolders';

function loadOpenFoldersFromStorage(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(OPEN_FOLDERS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((s) => typeof s === 'string'));
  } catch {
    // fall through
  }
  return new Set();
}

function persistOpenFolders(): void {
  const arr = [...openFolders];
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify(arr));
    } catch {
      // Best-effort; quota errors fall through.
    }
  }
  // Mirror to .app-config.json so the state survives an iOS WebKit
  // storage purge or an Android WebView reset (localStorage isn't
  // guaranteed durable on either platform). Best-effort, async.
  if (isTauri) {
    void import('./platform/tauri').then(({ saveConfig }) => {
      saveConfig({ openFolders: arr }).catch(() => { /* silent */ });
    }).catch(() => { /* non-Tauri or import failed */ });
  }
}

/** Async-load the persisted folder set from the durable app config
 *  file and apply it on top of the synchronously-loaded localStorage
 *  value. The file is more durable than localStorage on mobile, so it
 *  wins when both exist. Runs once per webview load. */
async function hydrateOpenFoldersFromConfig(): Promise<void> {
  if (!isTauri) return;
  try {
    const { loadOpenFoldersConfig } = await import('./platform/tauri');
    const stored = await loadOpenFoldersConfig();
    if (stored === null) {
      // Nothing on disk yet — seed it from whatever localStorage had,
      // so the next launch has a durable copy even if WebKit purges.
      if (openFolders.size > 0) persistOpenFolders();
      return;
    }
    openFolders = new Set(stored);
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify(stored)); } catch { /* quota */ }
    }
  } catch {
    // Best-effort — fall through to whatever localStorage gave us.
  }
}

if (typeof window !== 'undefined') {
  void hydrateOpenFoldersFromConfig();
}

export function isFolderOpen(path: string): boolean {
  return openFolders.has(path) || dragHoverExpanded.has(path);
}

export function toggleFolderOpen(path: string): void {
  const next = new Set(openFolders);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  openFolders = next;
  persistOpenFolders();
}

export function setFolderOpen(path: string, open: boolean): void {
  if (openFolders.has(path) === open) return;
  const next = new Set(openFolders);
  if (open) next.add(path);
  else next.delete(path);
  openFolders = next;
  persistOpenFolders();
}

function ancestorFolders(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

export function openFolderAndAncestors(path: string): void {
  if (!path) return;
  const next = new Set(openFolders);
  let changed = false;
  for (const folder of ancestorFolders(path)) {
    if (next.has(folder)) continue;
    next.add(folder);
    changed = true;
  }
  if (!changed) return;
  openFolders = next;
  persistOpenFolders();
}

function rebasePathSet(paths: Set<string>, fromPath: string, toPath: string): Set<string> {
  const next = new Set<string>();
  for (const path of paths) {
    if (path === fromPath) {
      next.add(toPath);
    } else if (path.startsWith(`${fromPath}/`)) {
      next.add(`${toPath}/${path.slice(fromPath.length + 1)}`);
    } else {
      next.add(path);
    }
  }
  return next;
}

/** Mark a folder as drag-hover expanded (transient, does not persist). */
export function setDragHoverExpanded(path: string, expanded: boolean): void {
  if (dragHoverExpanded.has(path) === expanded) return;
  const next = new Set(dragHoverExpanded);
  if (expanded) next.add(path);
  else next.delete(path);
  dragHoverExpanded = next;
}

export function clearDragHoverExpanded(): void {
  if (dragHoverExpanded.size === 0) return;
  dragHoverExpanded = new Set();
}

// ── Empty folders ────────────────────────────────────────────────────

export function getEmptyFolders(): ReadonlySet<string> {
  return emptyFolders;
}

export async function refreshEmptyFolders(notes: NotePreview[]): Promise<void> {
  // Folders that actually contain notes (anywhere in the descendant tree)
  // are NOT empty; everything else listed on disk is.
  const fs = getFS();
  let entries: { path: string }[];
  try {
    if (fs.listFolders) {
      entries = await fs.listFolders();
    } else {
      entries = [];
    }
  } catch {
    entries = [];
  }
  const allDirs = new Set(entries.map((e) => e.path));
  const populated = new Set<string>();
  for (const note of notes) {
    const components = note.id.split('/');
    for (let i = 1; i < components.length; i++) {
      populated.add(components.slice(0, i).join('/'));
    }
  }
  const empty = new Set<string>();
  for (const dir of allDirs) {
    if (!populated.has(dir)) empty.add(dir);
  }
  emptyFolders = empty;
}

// ── Tree model ───────────────────────────────────────────────────────

export interface FolderNode {
  type: 'folder';
  path: string;
  name: string;
  depth: number;
  /** True when no note (anywhere under it) has been written yet. */
  isEmpty: boolean;
  children: TreeNode[];
}

export interface NoteNode {
  type: 'note';
  note: NotePreview;
  depth: number;
  /** Parent folder path of `note.id` — '' for root-level notes. Computed
   *  once during tree build so drag handlers don't re-derive it per row. */
  parentPath: string;
}

export type TreeNode = FolderNode | NoteNode;

/**
 * Build the rendered folder/note tree from the notes index plus the
 * empty-folder set.
 *
 * Sorting (per §UI/Sidebar):
 *   - Folders alphabetically above notes at every level.
 *   - Notes within a folder use the existing default sort
 *     (modificationTime desc, then id asc) — already applied to
 *     `notes` by `getAllNotes()`, so we preserve input order.
 */
export function buildFolderTree(notes: NotePreview[]): TreeNode[] {
  const folders = new Map<string, FolderNode>();
  const ensureFolder = (path: string, isEmpty: boolean): FolderNode => {
    let node = folders.get(path);
    if (!node) {
      const components = path.split('/');
      const name = components[components.length - 1];
      node = {
        type: 'folder',
        path,
        name,
        depth: components.length - 1,
        isEmpty,
        children: [],
      };
      folders.set(path, node);
    } else if (!isEmpty) {
      // Folders that contain notes anywhere are not empty.
      node.isEmpty = false;
    }
    return node;
  };

  const roots: TreeNode[] = [];

  // Seed folders from the empty-folder set (and ancestors).
  for (const path of emptyFolders) {
    const components = path.split('/');
    for (let i = 1; i <= components.length; i++) {
      const ancestor = components.slice(0, i).join('/');
      ensureFolder(ancestor, true);
    }
  }

  // Add notes; create ancestor folders as we go. Dedupe by id —
  // transient race windows during sync apply / watcher refresh can
  // briefly produce a duplicate id in `notesCache`, and Svelte 5's
  // keyed `{#each}` crashes on a duplicate key (`each_key_duplicate`).
  const seenIds = new Set<string>();
  for (const note of notes) {
    if (seenIds.has(note.id)) continue;
    seenIds.add(note.id);
    const components = note.id.split('/');
    let parent: FolderNode | null = null;
    for (let i = 1; i < components.length; i++) {
      const folderPath = components.slice(0, i).join('/');
      const folder = ensureFolder(folderPath, false);
      if (parent) {
        if (!parent.children.includes(folder)) parent.children.push(folder);
      } else {
        if (!roots.includes(folder)) roots.push(folder);
      }
      parent = folder;
    }
    const noteNode: NoteNode = {
      type: 'note',
      note,
      depth: components.length - 1,
      parentPath: parent?.path ?? '',
    };
    if (parent) parent.children.push(noteNode);
    else roots.push(noteNode);
  }

  // Add empty folders (and any folder we created without notes) to
  // their parents so the user-created empty folders show up.
  for (const folder of folders.values()) {
    if (folder.depth === 0) {
      if (!roots.includes(folder)) roots.push(folder);
      continue;
    }
    const components = folder.path.split('/');
    const parentPath = components.slice(0, -1).join('/');
    const parent = folders.get(parentPath);
    if (parent && !parent.children.includes(folder)) {
      parent.children.push(folder);
    }
  }

  sortLevel(roots);
  return roots;
}

function sortLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    // Folders before notes
    if (a.type === 'folder' && b.type === 'note') return -1;
    if (a.type === 'note' && b.type === 'folder') return 1;
    if (a.type === 'folder' && b.type === 'folder') {
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }
    // both notes — preserve input order (already sorted by mtime desc)
    return 0;
  });
  for (const n of nodes) {
    if (n.type === 'folder') sortLevel(n.children);
  }
}

/** Flatten the visible portion of the tree into a list for rendering.
 *  Closed folders contribute themselves but no descendants. */
export function flattenTree(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.type === 'folder' && isFolderOpen(n.path)) {
        walk(n.children);
      }
    }
  };
  walk(tree);
  return out;
}

// ── Folder operations (validation + dispatch) ─────────────────────────

export interface CreateFolderResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Create a folder under `parentPath` (root = ''). Validates the name
 * against §7 (character/dot rules, Windows-reserved names, sibling
 * case-collision, depth limit). On success, persists the folder and
 * marks it open so the UI shows it expanded.
 */
export async function createFolder(
  parentPath: string,
  name: string,
  siblings: Iterable<string>,
): Promise<CreateFolderResult> {
  if (!isValidFolderName(name)) {
    const issues = validateFolderName(name);
    return { ok: false, error: issues[0]?.message ?? 'Invalid folder name' };
  }
  if (hasCaseInsensitiveSiblingCollision(name, siblings)) {
    return {
      ok: false,
      error: `A folder named "${name}" already exists at this level`,
    };
  }
  const fullPath = parentPath ? `${parentPath}/${name}` : name;
  if (pathDepth(fullPath) > MAX_FOLDER_DEPTH) {
    return { ok: false, error: `Folder depth cannot exceed ${MAX_FOLDER_DEPTH}` };
  }
  try {
    const fs = getFS();
    if (fs.createFolder) {
      await fs.createFolder(fullPath);
    }
    openFolderAndAncestors(fullPath);
    return { ok: true, path: fullPath };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'Failed to create folder' };
  }
}

/**
 * Rename a folder (`fromPath` → sibling under same parent with new name)
 * or move it under a different parent. Caller chooses by passing the
 * full new path. Validates per §7 and updates wikilinks for every note
 * inside.
 */
export async function renameOrMoveFolder(
  fromPath: string,
  toPath: string,
  siblings: Iterable<string>,
): Promise<{ ok: boolean; error?: string }> {
  if (fromPath === toPath) return { ok: true };
  // Each component of the new path must be valid.
  const components = toPath.split('/');
  if (pathDepth(toPath) + 1 > MAX_FOLDER_DEPTH + 1) {
    return { ok: false, error: `Folder depth cannot exceed ${MAX_FOLDER_DEPTH}` };
  }
  for (const c of components) {
    if (!isValidFolderName(c)) {
      const issues = validateFolderName(c);
      return { ok: false, error: issues[0]?.message ?? 'Invalid folder name' };
    }
  }
  // Sibling collision is checked against the parent of toPath.
  const newName = components[components.length - 1];
  if (hasCaseInsensitiveSiblingCollision(newName, siblings)) {
    return { ok: false, error: `A folder named "${newName}" already exists at this level` };
  }
  try {
    const fs = getFS();
    // Move the folder (and contained notes) on disk.
    if (fs.renameFolder) {
      await fs.renameFolder(fromPath, toPath);
    }
    // Update folder-state structures for the moved subtree, not just
    // the top-level folder. Without this, moving an open nested tree to
    // `work/archive` leaves stale `archive/...` open-state behind and
    // makes mobile navigation look like mixed folders.
    openFolders = rebasePathSet(openFolders, fromPath, toPath);
    openFolderAndAncestors(toPath);
    persistOpenFolders();
    emptyFolders = rebasePathSet(emptyFolders, fromPath, toPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'Failed to rename folder' };
  }
}

export async function deleteFolder(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const fs = getFS();
    if (fs.deleteFolder) {
      await fs.deleteFolder(path);
    }
    const nextOpen = new Set([...openFolders].filter((p) => p !== path && !p.startsWith(`${path}/`)));
    if (nextOpen.size !== openFolders.size) {
      openFolders = nextOpen;
      persistOpenFolders();
    }
    const nextEmpty = new Set([...emptyFolders].filter((p) => p !== path && !p.startsWith(`${path}/`)));
    if (nextEmpty.size !== emptyFolders.size) {
      emptyFolders = nextEmpty;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'Failed to delete folder' };
  }
}
