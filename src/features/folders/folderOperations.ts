import { getLocalNoteStore, type LocalNoteRename } from '$lib/localNoteStore';
import { idLeaf, idParent } from '$lib/platform/pathSafety';
import {
  hasCaseInsensitiveSiblingCollision,
  MAX_FOLDER_DEPTH,
  MAX_TITLE_LENGTH,
  validateFolderName,
} from '$lib/rules';
import type { LocalizedMessage } from '$shared/localization';

import {
  openFolderAndAncestors,
  rebaseOpenFolders,
  removeOpenFolderTree,
} from './folderExpansion.svelte';

export interface CreateFolderResult {
  ok: boolean;
  path?: string;
  error?: LocalizedMessage;
}

function folderDepth(path: string): number {
  return path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean).length;
}

function folderOperationError(diagnostic: string, fallback: LocalizedMessage): LocalizedMessage {
  console.warn(diagnostic);
  return fallback;
}

// The shared rules are written for note titles ("That character can't be used
// in a note title"), because `validateFolderName` layers on `validateTitle`.
// Naming the surface is the caller's job, so the manifest stays generic and a
// folder dialog never tells the user they broke a *note title* rule.
/** The first shared-rule violation in `name`, worded for a folder. */
export function validateFolderNameForDisplay(name: string): LocalizedMessage | null {
  const issue = validateFolderName(name)[0];
  if (!issue) return null;
  switch (issue.kind) {
    case 'empty':
      return { path: 'folders.validation.empty' };
    case 'forbidden_chars':
      return { path: 'folders.validation.forbiddenCharacter' };
    case 'leading_dots':
      return { path: 'folders.validation.leadingDot' };
    case 'trailing_dots':
      return { path: 'folders.validation.trailingDot' };
    case 'too_long':
      return {
        path: 'folders.validation.tooLong',
        arguments: { maxLength: MAX_TITLE_LENGTH },
      };
    case 'reserved_name':
      return { path: 'folders.validation.reservedName', arguments: { folderName: name } };
    case 'case_collision':
      return { path: 'folders.duplicateName' };
    case 'depth_exceeded':
      return { path: 'folders.validation.tooDeep', arguments: { maxDepth: MAX_FOLDER_DEPTH } };
  }
}

export function validateNewFolderName(
  parentPath: string,
  name: string,
  siblings: Iterable<string>,
): LocalizedMessage | null {
  const nameError = validateFolderNameForDisplay(name);
  if (nameError) return nameError;
  if (hasCaseInsensitiveSiblingCollision(name, siblings)) {
    return { path: 'folders.duplicateName' };
  }
  const path = parentPath ? `${parentPath}/${name}` : name;
  if (folderDepth(path) > MAX_FOLDER_DEPTH) {
    return { path: 'folders.validation.tooDeep', arguments: { maxDepth: MAX_FOLDER_DEPTH } };
  }
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
  } catch {
    return {
      ok: false,
      error: folderOperationError('Folder creation failed', {
        path: 'folders.errors.createFailed',
      }),
    };
  }
}

export async function renameOrMoveFolder(
  fromPath: string,
  toPath: string,
  siblings: Iterable<string>,
): Promise<{
  ok: boolean;
  error?: LocalizedMessage;
  renames?: LocalNoteRename[];
  finalFolder?: string;
}> {
  if (fromPath === toPath) return { ok: true };
  if (folderDepth(toPath) > MAX_FOLDER_DEPTH) {
    return {
      ok: false,
      error: { path: 'folders.validation.tooDeep', arguments: { maxDepth: MAX_FOLDER_DEPTH } },
    };
  }

  const components = toPath.split('/');
  for (const component of components) {
    const componentError = validateFolderNameForDisplay(component);
    if (componentError) return { ok: false, error: componentError };
  }
  const newName = components[components.length - 1] ?? '';
  if (hasCaseInsensitiveSiblingCollision(newName, siblings)) {
    return {
      ok: false,
      error: {
        path: 'folders.validation.duplicateAtLevel',
        arguments: { folderName: newName },
      },
    };
  }

  try {
    const mutation = await (await getLocalNoteStore()).renameFolder(fromPath, toPath);
    const { _applyLocalMutation } = await import('$features/notes/notes.svelte');
    _applyLocalMutation(mutation);
    const finalFolder = mutation.finalFolder ?? toPath;
    rebaseOpenFolders(fromPath, finalFolder);
    return { ok: true, renames: mutation.renamed, finalFolder };
  } catch {
    return {
      ok: false,
      error: folderOperationError('Folder rename failed', {
        path: 'folders.errors.renameFailed',
      }),
    };
  }
}

/**
 * Rename a folder to a new NAME inside its current parent.
 *
 * Distinct from `renameOrMoveFolder`, which takes a destination PATH: a name
 * typed into the inline rename field is a single path component, so `a/b` is an
 * illegal name — not an instruction to move the folder into a new `a`. Splicing
 * the typed text into the destination path is exactly how that used to happen
 * silently.
 */
export async function renameFolderInPlace(
  path: string,
  newName: string,
  siblings: Iterable<string>,
): Promise<{
  ok: boolean;
  error?: LocalizedMessage;
  renames?: LocalNoteRename[];
  finalFolder?: string;
}> {
  const parent = idParent(path);
  const trimmed = newName.trim();
  if (trimmed === idLeaf(path)) return { ok: true };

  const siblingList = [...siblings];
  const error = validateNewFolderName(parent, trimmed, siblingList);
  if (error) return { ok: false, error };

  return renameOrMoveFolder(path, parent ? `${parent}/${trimmed}` : trimmed, siblingList);
}

export async function moveFolder(
  fromPath: string,
  destinationParent: string,
): Promise<{
  ok: boolean;
  error?: LocalizedMessage;
  renames?: LocalNoteRename[];
  finalFolder?: string;
}> {
  try {
    const mutation = await (await getLocalNoteStore()).moveFolder(fromPath, destinationParent);
    const { _applyLocalMutation } = await import('$features/notes/notes.svelte');
    _applyLocalMutation(mutation);
    const finalFolder = mutation.finalFolder ?? fromPath;
    rebaseOpenFolders(fromPath, finalFolder);
    return { ok: true, renames: mutation.renamed, finalFolder };
  } catch {
    return {
      ok: false,
      error: folderOperationError('Folder move failed', { path: 'folders.errors.moveFailed' }),
    };
  }
}

export async function deleteFolder(
  path: string,
): Promise<{ ok: boolean; error?: LocalizedMessage; renames?: LocalNoteRename[] }> {
  try {
    const mutation = await (await getLocalNoteStore()).deleteFolder(path);
    const { _applyLocalMutation } = await import('$features/notes/notes.svelte');
    _applyLocalMutation(mutation);
    removeOpenFolderTree(path);
    return { ok: true, renames: mutation.renamed };
  } catch {
    return {
      ok: false,
      error: folderOperationError('Folder deletion failed', {
        path: 'folders.errors.deleteFailed',
      }),
    };
  }
}
