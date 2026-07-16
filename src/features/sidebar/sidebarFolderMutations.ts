import { clearDragHoverExpanded } from '$features/folders/folderExpansion.svelte';
import { getEmptyFolders, refreshEmptyFolders } from '$features/folders/emptyFolders.svelte';
import { deleteFolder, renameOrMoveFolder } from '$features/folders/folderOperations';
import {
  deleteNote,
  getAllNotes,
  moveNote,
  moveNotesUnderPrefix,
} from '$features/notes/notes.svelte';
import { idLeaf } from '$lib/platform/pathSafety';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';

interface DeleteFolderOptions {
  getActiveNoteId: () => string | null;
  onSelect: (id: string) => void;
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

export async function refreshSidebarFolders(): Promise<void> {
  await refreshEmptyFolders(getAllNotes());
}

export async function renameSidebarFolder(path: string, newName: string): Promise<string | null> {
  const components = path.split('/');
  const parent = components.slice(0, -1).join('/');
  const trimmedName = newName.trim();
  const newPath = parent ? `${parent}/${trimmedName}` : trimmedName;
  if (newPath === path) return null;

  const siblings = collectSiblingFolders(parent).filter(
    (name) => name !== components[components.length - 1],
  );
  const result = await renameOrMoveFolder(path, newPath, siblings);
  if (!result.ok) return result.error ?? 'Failed to rename';
  await moveNotesUnderPrefix(path, newPath);
  await refreshSidebarFolders();
  return null;
}

export async function moveSidebarNote(noteId: string, target: string): Promise<void> {
  const newId = target ? `${target}/${idLeaf(noteId)}` : idLeaf(noteId);
  if (newId === noteId) return;
  try {
    await moveNote(noteId, newId);
    await refreshSidebarFolders();
    showGlobalToast(target ? `Moved to ${target}` : 'Moved to Notes');
  } catch (error) {
    showGlobalToast(error instanceof Error ? error.message : 'Move failed');
  }
}

export async function confirmDeleteSidebarNote(id: string): Promise<void> {
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
    await deleteNote(id);
    showGlobalToast('Note deleted');
  } catch (error) {
    showGlobalToast(error instanceof Error ? error.message : 'Delete failed');
  }
}

export async function confirmDeleteSidebarFolder(
  path: string,
  options: DeleteFolderOptions,
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
  // The shared store plans collisions, moves every note with rollback on
  // failure, rewrites backlinks, then removes the remaining folder tree.
  const result = await deleteFolder(path);
  if (!result.ok) {
    showGlobalToast(result.error ?? 'Failed to delete folder');
    return;
  }
  await refreshSidebarFolders();
  const movedNotes = new Map(result.renames?.map((rename) => [rename.from, rename.to]) ?? []);

  const activeId = options.getActiveNoteId();
  if (activeId && activeId !== 'new' && activeId.startsWith(prefix)) {
    options.onSelect(movedNotes.get(activeId) ?? '__home__');
  }
  const movedCount = result.renames?.length ?? 0;
  showGlobalToast(
    movedCount > 0
      ? `Folder deleted; moved ${movedCount} note${movedCount === 1 ? '' : 's'}`
      : 'Folder deleted',
  );
}

export async function moveSidebarNoteToFolder(noteId: string, folderPath: string): Promise<void> {
  try {
    await moveSidebarNote(noteId, folderPath);
  } finally {
    clearDragHoverExpanded();
  }
}

export async function moveSidebarNoteToRoot(noteId: string): Promise<void> {
  try {
    await moveSidebarNote(noteId, '');
  } finally {
    clearDragHoverExpanded();
  }
}

export async function moveSidebarFolder(folderPath: string, targetPath: string): Promise<void> {
  if (folderPath === targetPath || targetPath.startsWith(`${folderPath}/`)) return;
  const newPath = `${targetPath}/${idLeaf(folderPath)}`;
  const result = await renameOrMoveFolder(folderPath, newPath, collectSiblingFolders(targetPath));
  if (!result.ok) {
    showGlobalToast(result.error ?? 'Failed to move folder');
    return;
  }
  await moveNotesUnderPrefix(folderPath, newPath);
  await refreshSidebarFolders();
  showGlobalToast(`Moved to ${targetPath}`);
  clearDragHoverExpanded();
}

export async function moveSidebarFolderToRoot(folderPath: string): Promise<void> {
  const leaf = idLeaf(folderPath);
  if (folderPath === leaf) return;
  const result = await renameOrMoveFolder(folderPath, leaf, collectSiblingFolders(''));
  if (!result.ok) {
    showGlobalToast(result.error ?? 'Failed to move folder');
    return;
  }
  await moveNotesUnderPrefix(folderPath, leaf);
  await refreshSidebarFolders();
  showGlobalToast('Moved to Notes');
  clearDragHoverExpanded();
}
