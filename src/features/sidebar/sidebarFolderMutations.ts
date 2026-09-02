import { clearDragHoverExpanded } from '$features/folders/folderExpansion.svelte';
import { getEmptyFolders } from '$features/folders/emptyFolders.svelte';
import { deleteFolder, moveFolder, renameFolderInPlace } from '$features/folders/folderOperations';
import {
  folderDeleteConfirmation,
  noteDeleteIsPermanent,
} from '$features/notes/deleteConfirmation';
import { pickNoteForAction } from '$features/notes/noteActionTarget';
import { deleteNote, getAllNotes, moveNote } from '$features/notes/notes.svelte';
import { idLeaf, idParent } from '$lib/platform/pathSafety';
import { validateTitle } from '$lib/rules';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import {
  localizedText,
  resolveLocalizedMessage,
  type LocalizedMessage,
} from '$shared/localization';
import { titleValidationMessage } from '$features/notes/titleValidationMessage';

interface SidebarMutationOptions {
  getActiveNoteId: () => string | null;
  runWithActiveNoteLock: <T>(operation: () => Promise<T>) => Promise<T>;
  onNoteIdsRenamed: (renames: Array<{ from: string; to: string }>) => void;
  onNoteIdsDeleted: (ids: string[]) => void;
  onSelect: (id: string) => void;
  onActiveNoteDeleted: () => void;
  onActiveNoteMoved: (fromId: string, toId: string, title: string) => void;
}

function runWithActiveNoteLockIfInFolder<T>(
  folderPath: string,
  options: SidebarMutationOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const activeId = options.getActiveNoteId();
  if (activeId && activeId !== 'new' && activeId.startsWith(`${folderPath}/`)) {
    return options.runWithActiveNoteLock(operation);
  }
  return operation();
}

function retargetActiveNote(
  renames: Array<{ from: string; to: string }> | undefined,
  options: SidebarMutationOptions,
): boolean {
  const activeId = options.getActiveNoteId();
  if (!activeId) return false;
  const rename = renames?.find((candidate) => candidate.from === activeId);
  if (!rename) return false;
  options.onActiveNoteMoved(rename.from, rename.to, idLeaf(rename.to));
  return true;
}

export function collectSiblingFolders(parentPath: string): string[] {
  const siblings = new Set<string>();
  const prefix = parentPath ? `${parentPath}/` : '';

  for (const note of getAllNotes()) {
    if (parentPath && !note.id.startsWith(prefix)) continue;
    const relativePath = parentPath ? note.id.slice(prefix.length) : note.id;
    const slash = relativePath.indexOf('/');
    if (slash !== -1) siblings.add(relativePath.slice(0, slash));
  }
  for (const folder of getEmptyFolders()) {
    if (parentPath && !folder.startsWith(prefix) && folder !== parentPath) continue;
    const relativePath = parentPath ? folder.slice(prefix.length) : folder;
    if (!relativePath || relativePath.startsWith('/')) continue;
    const slash = relativePath.indexOf('/');
    siblings.add(slash === -1 ? relativePath : relativePath.slice(0, slash));
  }
  return [...siblings];
}

export async function renameSidebarFolder(
  path: string,
  newName: string,
  options: SidebarMutationOptions,
): Promise<LocalizedMessage | null> {
  const parent = idParent(path);
  const siblings = collectSiblingFolders(parent).filter((name) => name !== idLeaf(path));
  return runWithActiveNoteLockIfInFolder(path, options, async () => {
    const result = await renameFolderInPlace(path, newName, siblings);
    if (!result.ok) return result.error ?? { path: 'folders.errors.renameFailed' };
    options.onNoteIdsRenamed(result.renames ?? []);
    retargetActiveNote(result.renames, options);
    return null;
  });
}

/**
 * Rename a note in place — that is, rename its file. The typed text becomes the
 * filename verbatim (AGENTS.md M2: the filename IS the title), so an illegal
 * name is REJECTED rather than quietly sanitized into something else, and the
 * move itself goes through the Rust-backed store so backlinks and the note
 * cache are projected from one committed mutation.
 */
export async function renameSidebarNote(
  noteId: string,
  newTitle: string,
  options: SidebarMutationOptions,
): Promise<LocalizedMessage | null> {
  const trimmed = newTitle.trim();
  if (trimmed === idLeaf(noteId)) return null;

  const issue = validateTitle(trimmed)[0];
  if (issue) return titleValidationMessage(issue.kind);

  const parent = idParent(noteId);
  const newId = parent ? `${parent}/${trimmed}` : trimmed;
  const collides = getAllNotes().some(
    (note) => note.id !== noteId && note.id.toLowerCase() === newId.toLowerCase(),
  );
  if (collides) return { path: 'notes.title.duplicate' };

  try {
    const pick = pickNoteForAction(noteId);
    // Always locked: whether this row is the open note is unanswerable until
    // its pending rename has landed (same reasoning as moveSidebarNote).
    return await options.runWithActiveNoteLock(async () => {
      const fromId = pick.resolve();
      if (!fromId) return { path: 'notes.unavailable' };
      const targetId = parent ? `${parent}/${trimmed}` : trimmed;
      const renamingActiveNote = options.getActiveNoteId() === fromId;
      const result = await moveNote(fromId, targetId);
      options.onNoteIdsRenamed([{ from: fromId, to: result.id }]);
      if (renamingActiveNote) {
        options.onActiveNoteMoved(fromId, result.id, idLeaf(result.id));
      }
      return null;
    });
  } catch (cause) {
    console.warn('Failed to rename sidebar note', cause);
    return { path: 'notes.errors.renameFailed' };
  }
}

export async function moveSidebarNote(
  noteId: string,
  target: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    const pick = pickNoteForAction(noteId);
    // Always locked: whether this row is the open note is unanswerable until its
    // pending rename has landed.
    await options.runWithActiveNoteLock(async () => {
      const fromId = pick.resolve();
      if (!fromId) return showGlobalToast({ path: 'notes.unavailable' });
      const newId = target ? `${target}/${idLeaf(fromId)}` : idLeaf(fromId);
      if (newId === fromId) return;
      const movingActiveNote = options.getActiveNoteId() === fromId;
      const result = await moveNote(fromId, newId);
      options.onNoteIdsRenamed([{ from: fromId, to: result.id }]);
      if (movingActiveNote) {
        options.onActiveNoteMoved(fromId, result.id, idLeaf(result.id));
      }
      showGlobalToast(
        target
          ? { path: 'notes.movedTo', arguments: { destination: target } }
          : { path: 'notes.movedToNotes' },
      );
    });
  } catch (cause) {
    console.warn('Failed to move sidebar note', cause);
    showGlobalToast({ path: 'notes.errors.moveFailed' });
  }
}

export async function confirmDeleteSidebarNote(
  id: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    const confirmation = (await noteDeleteIsPermanent())
      ? localizedText('notes.delete.namedNotePermanentConfirmation', {
          noteTitle: idLeaf(id),
        })
      : localizedText('notes.delete.namedNoteRecoverableConfirmation', {
          noteTitle: idLeaf(id),
        });
    const confirmed = await confirmDialog(confirmation, {
      title: localizedText('notes.delete.heading'),
      kind: 'warning',
    });
    if (!confirmed) return;
  } catch (error) {
    console.warn('[delete-note] confirmation dialog failed:', error);
    showGlobalToast({ path: 'notes.errors.confirmationUnavailable' });
    return;
  }

  try {
    const pick = pickNoteForAction(id);
    await options.runWithActiveNoteLock(async () => {
      const deleteId = pick.resolve();
      if (!deleteId) return showGlobalToast({ path: 'notes.unavailable' });
      await deleteNote(deleteId);
      if (options.getActiveNoteId() === deleteId) options.onActiveNoteDeleted();
      options.onNoteIdsDeleted([deleteId]);
      showGlobalToast({ path: 'notes.deleted' });
    });
  } catch (cause) {
    console.warn('Failed to delete sidebar note', cause);
    showGlobalToast({ path: 'notes.errors.deleteFailed' });
  }
}

export async function confirmDeleteSidebarFolder(
  path: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    const confirmed = await confirmDialog(
      resolveLocalizedMessage(await folderDeleteConfirmation()),
      {
        title: localizedText('folders.delete.heading'),
        kind: 'warning',
      },
    );
    if (!confirmed) return;
  } catch (error) {
    console.warn('[delete-folder] confirmation dialog failed:', error);
    showGlobalToast({ path: 'folders.errors.confirmationUnavailable' });
    return;
  }

  const prefix = `${path}/`;
  await runWithActiveNoteLockIfInFolder(path, options, async () => {
    // The shared store plans collisions, moves every note with rollback on
    // failure, rewrites backlinks, then removes the remaining folder tree.
    const result = await deleteFolder(path);
    if (!result.ok) {
      showGlobalToast(result.error ?? { path: 'folders.errors.deleteFailed' });
      return;
    }
    options.onNoteIdsRenamed(result.renames ?? []);
    const movedNotes = new Map(result.renames?.map((rename) => [rename.from, rename.to]) ?? []);

    const activeId = options.getActiveNoteId();
    if (activeId && activeId !== 'new' && activeId.startsWith(prefix)) {
      if (!retargetActiveNote(result.renames, options)) {
        options.onSelect(movedNotes.get(activeId) ?? '__home__');
      }
    }
    const movedCount = result.renames?.length ?? 0;
    showGlobalToast(
      movedCount > 0
        ? { path: 'folders.delete.movedNotes', arguments: { count: movedCount } }
        : { path: 'folders.deleted' },
    );
  });
}

export async function moveSidebarNoteToFolder(
  noteId: string,
  folderPath: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    await moveSidebarNote(noteId, folderPath, options);
  } finally {
    clearDragHoverExpanded();
  }
}

export async function moveSidebarNoteToRoot(
  noteId: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    await moveSidebarNote(noteId, '', options);
  } finally {
    clearDragHoverExpanded();
  }
}

export async function moveSidebarFolder(
  folderPath: string,
  targetPath: string,
  options: SidebarMutationOptions,
): Promise<void> {
  if (folderPath === targetPath || targetPath.startsWith(`${folderPath}/`)) return;
  await runWithActiveNoteLockIfInFolder(folderPath, options, async () => {
    const result = await moveFolder(folderPath, targetPath);
    if (!result.ok) {
      showGlobalToast(result.error ?? { path: 'folders.errors.moveFailed' });
      return;
    }
    options.onNoteIdsRenamed(result.renames ?? []);
    retargetActiveNote(result.renames, options);
    showGlobalToast({ path: 'folders.movedTo', arguments: { destination: targetPath } });
    clearDragHoverExpanded();
  });
}

export async function moveSidebarFolderToRoot(
  folderPath: string,
  options: SidebarMutationOptions,
): Promise<void> {
  const leaf = idLeaf(folderPath);
  if (folderPath === leaf) return;
  await runWithActiveNoteLockIfInFolder(folderPath, options, async () => {
    const result = await moveFolder(folderPath, '');
    if (!result.ok) {
      showGlobalToast(result.error ?? { path: 'folders.errors.moveFailed' });
      return;
    }
    options.onNoteIdsRenamed(result.renames ?? []);
    retargetActiveNote(result.renames, options);
    showGlobalToast({ path: 'folders.movedToNotes' });
    clearDragHoverExpanded();
  });
}
