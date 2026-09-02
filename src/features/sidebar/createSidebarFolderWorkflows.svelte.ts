import { createFolder, validateNewFolderName } from '$features/folders/folderOperations';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import type { LocalizedMessage } from '$shared/localization';
import {
  collectSiblingFolders,
  confirmDeleteSidebarFolder,
  confirmDeleteSidebarNote,
  moveSidebarFolder,
  moveSidebarFolderToRoot,
  moveSidebarNote,
  moveSidebarNoteToFolder,
  moveSidebarNoteToRoot,
  renameSidebarFolder,
  renameSidebarNote,
} from './sidebarFolderMutations';

export interface SidebarFolderMenuItem {
  label: LocalizedMessage;
  destructive?: boolean;
  onclick: () => void;
}

interface SidebarFolderWorkflowOptions {
  getActiveNoteId: () => string | null;
  runWithActiveNoteLock: <T>(operation: () => Promise<T>) => Promise<T>;
  onNoteIdsRenamed: (renames: Array<{ from: string; to: string }>) => void;
  onNoteIdsDeleted: (ids: string[]) => void;
  onSelect: (id: string) => void;
  onActiveNoteDeleted: () => void;
  onActiveNoteMoved: (fromId: string, toId: string, title: string) => void;
  onNewNoteInFolder: (folderPath: string) => void;
}

/** Folder rows expose the same discoverable action set on every platform
 * (docs/spec/list.md § Folder management). */
function folderMenuItems(on: {
  newNote: () => void;
  newFolder: () => void;
  rename: () => void;
  move: () => void;
  remove: () => void;
}): SidebarFolderMenuItem[] {
  return [
    { label: { path: 'notes.newNote' }, onclick: on.newNote },
    { label: { path: 'folders.newFolderTitleCase' }, onclick: on.newFolder },
    { label: { path: 'common.actions.rename' }, onclick: on.rename },
    { label: { path: 'folders.actions.moveToFolder' }, onclick: on.move },
    { label: { path: 'common.actions.delete' }, destructive: true, onclick: on.remove },
  ];
}

/** Note rows mirror the folder set minus the create actions — Rename is the
 * discoverable twin of the row's double-click / F2 gesture. */
function noteMenuItems(on: {
  rename: () => void;
  move: () => void;
  remove: () => void;
}): SidebarFolderMenuItem[] {
  return [
    { label: { path: 'common.actions.rename' }, onclick: on.rename },
    { label: { path: 'notes.actions.moveToFolder' }, onclick: on.move },
    { label: { path: 'common.actions.delete' }, destructive: true, onclick: on.remove },
  ];
}

export function createSidebarFolderWorkflows(options: SidebarFolderWorkflowOptions) {
  let isCreateFolderOpen = $state(false);
  let createFolderParent = $state('');
  let renameRequest = $state<{ path: string; nonce: number } | null>(null);
  let noteRenameRequest = $state<{ id: string; nonce: number } | null>(null);
  let folderPicker = $state<{
    title: LocalizedMessage;
    onpick: (target: string) => void;
    excludePaths: string[];
  } | null>(null);
  let contextMenu = $state<{
    x: number;
    y: number;
    items: SidebarFolderMenuItem[];
  } | null>(null);

  function openCreateFolder(parent: string): void {
    createFolderParent = parent;
    isCreateFolderOpen = true;
  }

  function closeCreateFolder(): void {
    isCreateFolderOpen = false;
  }

  function validateCreateFolder(name: string): LocalizedMessage | null {
    return validateNewFolderName(
      createFolderParent,
      name.trim(),
      collectSiblingFolders(createFolderParent),
    );
  }

  async function submitCreateFolder(name: string): Promise<LocalizedMessage | null> {
    const result = await createFolder(
      createFolderParent,
      name.trim(),
      collectSiblingFolders(createFolderParent),
    );
    if (!result.ok) return result.error ?? { path: 'folders.errors.createFailed' };
    closeCreateFolder();
    showGlobalToast({ path: 'folders.created' });
    return null;
  }

  function showFolderContextMenu(path: string, x: number, y: number): void {
    contextMenu = {
      x,
      y,
      items: folderMenuItems({
        newNote: () => options.onNewNoteInFolder(path),
        newFolder: () => openCreateFolder(path),
        rename: () => {
          renameRequest = { path, nonce: Date.now() };
        },
        move: () => openMoveFolderPicker(path),
        remove: () => void confirmDeleteSidebarFolder(path, options),
      }),
    };
  }

  function showNoteContextMenu(id: string, x: number, y: number): void {
    contextMenu = {
      x,
      y,
      items: noteMenuItems({
        rename: () => {
          noteRenameRequest = { id, nonce: Date.now() };
        },
        move: () => openMoveNotePicker(id),
        remove: () => void confirmDeleteSidebarNote(id, options),
      }),
    };
  }

  function closeContextMenu(): void {
    contextMenu = null;
  }

  function openMoveNotePicker(noteId: string): void {
    folderPicker = {
      title: { path: 'folders.movePickerHeading' },
      excludePaths: [],
      onpick: (target) => void moveNoteFromPicker(noteId, target),
    };
  }

  function openMoveFolderPicker(folderPath: string): void {
    const components = folderPath.split('/');
    folderPicker = {
      title: {
        path: 'folders.moveNamedHeading',
        arguments: { folderName: components[components.length - 1] ?? folderPath },
      },
      excludePaths: [folderPath],
      onpick: (target) => void moveFolderFromPicker(folderPath, target),
    };
  }

  async function moveFolderFromPicker(folderPath: string, target: string): Promise<void> {
    await moveSidebarFolder(folderPath, target, options);
    folderPicker = null;
  }

  async function moveNoteFromPicker(noteId: string, target: string): Promise<void> {
    await moveSidebarNote(noteId, target, options);
    folderPicker = null;
  }

  function closeFolderPicker(): void {
    folderPicker = null;
  }

  return {
    get isCreateFolderOpen() {
      return isCreateFolderOpen;
    },
    get createFolderParent() {
      return createFolderParent;
    },
    get renameRequest() {
      return renameRequest;
    },
    get noteRenameRequest() {
      return noteRenameRequest;
    },
    get folderPicker() {
      return folderPicker;
    },
    get contextMenu() {
      return contextMenu;
    },
    openCreateFolder,
    closeCreateFolder,
    validateCreateFolder,
    submitCreateFolder,
    showFolderContextMenu,
    showNoteContextMenu,
    closeContextMenu,
    renameFolder: (path: string, newName: string) => renameSidebarFolder(path, newName, options),
    renameNote: (id: string, newTitle: string) => renameSidebarNote(id, newTitle, options),
    closeFolderPicker,
    moveNoteToFolder: (noteId: string, folderPath: string) =>
      moveSidebarNoteToFolder(noteId, folderPath, options),
    moveNoteToRoot: (noteId: string) => moveSidebarNoteToRoot(noteId, options),
    moveFolder: (folderPath: string, targetPath: string) =>
      moveSidebarFolder(folderPath, targetPath, options),
    moveFolderToRoot: (folderPath: string) => moveSidebarFolderToRoot(folderPath, options),
  };
}
