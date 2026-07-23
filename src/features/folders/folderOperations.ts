import { getLocalNoteStore, type LocalNoteRename } from '$lib/localNoteStore';
import {
  hasCaseInsensitiveSiblingCollision,
  isValidFolderName,
  MAX_FOLDER_DEPTH,
  validateFolderName,
} from '$lib/rules';

import {
  openFolderAndAncestors,
  rebaseOpenFolders,
  removeOpenFolderTree,
} from './folderExpansion.svelte';

export interface CreateFolderResult {
  ok: boolean;
  path?: string;
  error?: string;
}

function folderDepth(path: string): number {
  return path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean).length;
}

function folderOperationError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function validateNewFolderName(
  parentPath: string,
  name: string,
  siblings: Iterable<string>,
): string | null {
  if (!isValidFolderName(name)) {
    return validateFolderName(name)[0]?.message ?? 'Invalid folder name';
  }
  if (hasCaseInsensitiveSiblingCollision(name, siblings)) {
    return 'A folder with this name already exists';
  }
  const path = parentPath ? `${parentPath}/${name}` : name;
  if (folderDepth(path) > MAX_FOLDER_DEPTH) return `Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`;
  return null;
}

export async function createFolder(
  parentPath: string,
  name: string,
  siblings: Iterable<string>,
): Promise<CreateFolderResult> {
  const error = validateNewFolderName(parentPath, name, siblings);
  if (error) return { ok: false, error };

  const path = parentPath ? `${parentPath}/${name}` : name;
  try {
    const mutation = await (await getLocalNoteStore()).createFolder(path);
    const { _applyLocalMutation } = await import('$features/notes/notes.svelte');
    _applyLocalMutation(mutation);
    openFolderAndAncestors(path);
    return { ok: true, path };
  } catch (cause) {
    return { ok: false, error: folderOperationError(cause, 'Failed to create folder') };
  }
}

export async function renameOrMoveFolder(
  fromPath: string,
  toPath: string,
  siblings: Iterable<string>,
): Promise<{ ok: boolean; error?: string; renames?: LocalNoteRename[] }> {
  if (fromPath === toPath) return { ok: true };
  if (folderDepth(toPath) > MAX_FOLDER_DEPTH) {
    return { ok: false, error: `Folder depth cannot exceed ${MAX_FOLDER_DEPTH}` };
  }

  const components = toPath.split('/');
  for (const component of components) {
    if (!isValidFolderName(component)) {
      return {
        ok: false,
        error: validateFolderName(component)[0]?.message ?? 'Invalid folder name',
      };
    }
  }
  const newName = components[components.length - 1] ?? '';
  if (hasCaseInsensitiveSiblingCollision(newName, siblings)) {
    return { ok: false, error: `A folder named "${newName}" already exists at this level` };
  }

  try {
    const mutation = await (await getLocalNoteStore()).renameFolder(fromPath, toPath);
    const { _applyLocalMutation } = await import('$features/notes/notes.svelte');
    _applyLocalMutation(mutation);
    rebaseOpenFolders(fromPath, toPath);
    return { ok: true, renames: mutation.renamed };
  } catch (cause) {
    return { ok: false, error: folderOperationError(cause, 'Failed to rename folder') };
  }
}

export async function deleteFolder(
  path: string,
): Promise<{ ok: boolean; error?: string; renames?: LocalNoteRename[] }> {
  try {
    const mutation = await (await getLocalNoteStore()).deleteFolder(path);
    const { _applyLocalMutation } = await import('$features/notes/notes.svelte');
    _applyLocalMutation(mutation);
    removeOpenFolderTree(path);
    return { ok: true, renames: mutation.renamed };
  } catch (cause) {
    return { ok: false, error: folderOperationError(cause, 'Failed to delete folder') };
  }
}
