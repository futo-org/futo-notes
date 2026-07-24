import { clearDragHoverExpanded } from '$features/folders/folderExpansion.svelte';
import { getEmptyFolders } from '$features/folders/emptyFolders.svelte';
import { deleteFolder, moveFolder, renameOrMoveFolder } from '$features/folders/folderOperations';
import { deleteNote, getAllNotes, moveNote } from '$features/notes/notes.svelte';
import { idLeaf } from '$lib/platform/pathSafety';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';

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
): Promise<string | null> {
  const components = path.split('/');
  const parent = components.slice(0, -1).join('/');
  const trimmedName = newName.trim();
  const newPath = parent ? `${parent}/${trimmedName}` : trimmedName;
  if (newPath === path) return null;

  const siblings = collectSiblingFolders(parent).filter(
    (name) => name !== components[components.length - 1],
  );
  return runWithActiveNoteLockIfInFolder(path, options, async () => {
    const result = await renameOrMoveFolder(path, newPath, siblings);
    if (!result.ok) return result.error ?? 'Failed to rename';
    options.onNoteIdsRenamed(result.renames ?? []);
    retargetActiveNote(result.renames, options);
    return null;
  });
}

export async function moveSidebarNote(
  noteId: string,
  target: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    const movingActiveNote = options.getActiveNoteId() === noteId;
    const move = async () => {
      const fromId = movingActiveNote ? (options.getActiveNoteId() ?? noteId) : noteId;
      const newId = target ? `${target}/${idLeaf(fromId)}` : idLeaf(fromId);
      if (newId === fromId) return;
      const result = await moveNote(fromId, newId);
      options.onNoteIdsRenamed([{ from: fromId, to: result.id }]);
      if (movingActiveNote) {
        options.onActiveNoteMoved(fromId, result.id, idLeaf(result.id));
      }
      showGlobalToast(target ? `Moved to ${target}` : 'Moved to Notes');
    };
    if (movingActiveNote) await options.runWithActiveNoteLock(move);
    else await move();
  } catch (error) {
    showGlobalToast(error instanceof Error ? error.message : 'Move failed');
  }
}

export async function confirmDeleteSidebarNote(
  id: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    const confirmed = await confirmDialog(`Delete note "${idLeaf(id)}"?`, {
      title: 'Delete note',
      kind: 'warning',
    });
    if (!confirmed) return;
  } catch (error) {
    console.warn('[delete-note] confirmation dialog failed:', error);
    showGlobalToast('Unable to show confirmation dialog');
    return;
  }

  try {
    const deletingActiveNote = options.getActiveNoteId() === id;
    const remove = async () => {
      const deleteId = deletingActiveNote ? (options.getActiveNoteId() ?? id) : id;
      await deleteNote(deleteId);
      if (deletingActiveNote) options.onActiveNoteDeleted();
      options.onNoteIdsDeleted([deleteId]);
      showGlobalToast('Note deleted');
    };
    if (deletingActiveNote) await options.runWithActiveNoteLock(remove);
    else await remove();
  } catch (error) {
    showGlobalToast(error instanceof Error ? error.message : 'Delete failed');
  }
}

export async function confirmDeleteSidebarFolder(
  path: string,
  options: SidebarMutationOptions,
): Promise<void> {
  try {
    const confirmed = await confirmDialog(
      'Delete this folder? Notes inside it will be moved to the parent folder.',
      { title: 'Delete folder', kind: 'warning' },
    );
    if (!confirmed) return;
  } catch (error) {
    console.warn('[delete-folder] confirmation dialog failed:', error);
    showGlobalToast('Unable to show confirmation dialog');
    return;
  }

  const prefix = `${path}/`;
  await runWithActiveNoteLockIfInFolder(path, options, async () => {
    // The shared store plans collisions, moves every note with rollback on
    // failure, rewrites backlinks, then removes the remaining folder tree.
    const result = await deleteFolder(path);
    if (!result.ok) {
      showGlobalToast(result.error ?? 'Failed to delete folder');
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
        ? `Folder deleted; moved ${movedCount} note${movedCount === 1 ? '' : 's'}`
        : 'Folder deleted',
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
      showGlobalToast(result.error ?? 'Failed to move folder');
      return;
    }
    options.onNoteIdsRenamed(result.renames ?? []);
    retargetActiveNote(result.renames, options);
    showGlobalToast(`Moved to ${targetPath}`);
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
      showGlobalToast(result.error ?? 'Failed to move folder');
      return;
    }
    options.onNoteIdsRenamed(result.renames ?? []);
    retargetActiveNote(result.renames, options);
    showGlobalToast('Moved to Notes');
    clearDragHoverExpanded();
  });
}
