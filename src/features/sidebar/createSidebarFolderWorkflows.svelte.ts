import { SHORTCUT_STEPS, type PuppetShortcutSteps } from '$app/puppet/puppetRegistry';
import { createFolder, validateNewFolderName } from '$features/folders/folderOperations';
import { vaultAvailability } from '$features/storage/vaultAvailability.svelte';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import type { LocalizedMessage } from '$shared/localization';
import {
  collectSiblingFolders,
  confirmDeleteSidebarFolder,
  confirmDeleteSidebarNote,
  moveSidebarFolder,
  moveSidebarNote,
  moveSidebarNoteToFolder,
  renameSidebarFolder,
  renameSidebarNote,
} from './sidebarFolderMutations';

export interface SidebarFolderMenuItem {
  label: LocalizedMessage;
  destructive?: boolean;
  disabled?: boolean;
  onclick: () => unknown;
  /** The option's `futo-puppet` verb (ContextMenu.svelte `MenuItem.verb`). */
  verb: {
    name: string;
    shortcut?: { argument: string; steps: PuppetShortcutSteps };
    confirms?: true;
  };
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

// Every row action writes to the vault, so an unusable one disables them all.
function lockedWhileVaultUnusable(items: SidebarFolderMenuItem[]): SidebarFolderMenuItem[] {
  return items.map((item) => ({ ...item, disabled: vaultAvailability.unavailable }));
}

/** Folder rows expose the same discoverable action set on every platform
 * (docs/spec/list.md § Folder management). */
function folderMenuItems(on: {
  newNote: () => void;
  newFolder: () => void;
  rename: () => void;
  move: () => void;
  remove: () => unknown;
}): SidebarFolderMenuItem[] {
  return [
    { label: { path: 'notes.newNote' }, onclick: on.newNote, verb: { name: 'NewNoteInFolder' } },
    {
      label: { path: 'folders.newFolderTitleCase' },
      onclick: on.newFolder,
      verb: {
        name: 'NewSubfolder',
        shortcut: { argument: 'name', steps: SHORTCUT_STEPS.newFolderName },
      },
    },
    {
      label: { path: 'common.actions.rename' },
      onclick: on.rename,
      verb: { name: 'RenameFolder', shortcut: { argument: 'name', steps: SHORTCUT_STEPS.newName } },
    },
    {
      label: { path: 'folders.actions.moveToFolder' },
      onclick: on.move,
      verb: {
        name: 'MoveFolderToFolder',
        shortcut: { argument: 'targetPath', steps: SHORTCUT_STEPS.targetPath },
      },
    },
    {
      label: { path: 'common.actions.delete' },
      destructive: true,
      onclick: on.remove,
      verb: { name: 'DeleteFolder', confirms: true },
    },
  ];
}

/** Note rows mirror the folder set minus the create actions — Rename is the
 * discoverable twin of the row's double-click / F2 gesture. */
function noteMenuItems(on: {
  rename: () => void;
  move: () => void;
  remove: () => unknown;
}): SidebarFolderMenuItem[] {
  return [
    {
      label: { path: 'common.actions.rename' },
      onclick: on.rename,
      verb: { name: 'RenameNote', shortcut: { argument: 'title', steps: SHORTCUT_STEPS.newName } },
    },
    {
      label: { path: 'notes.actions.moveToFolder' },
      onclick: on.move,
      verb: {
        name: 'MoveNoteToFolder',
        shortcut: { argument: 'targetPath', steps: SHORTCUT_STEPS.targetPath },
      },
    },
    {
      label: { path: 'common.actions.delete' },
      destructive: true,
      onclick: on.remove,
      verb: { name: 'DeleteNote', confirms: true },
    },
  ];
}

export function createSidebarFolderWorkflows(options: SidebarFolderWorkflowOptions) {
  let isCreateFolderOpen = $state(false);
  let createFolderParent = $state('');
  let renameRequest = $state<{ path: string; nonce: number } | null>(null);
  let noteRenameRequest = $state<{ id: string; nonce: number } | null>(null);
  let folderPicker = $state<{
    title: LocalizedMessage;
    onpick: (target: string) => Promise<void>;
    excludePaths: string[];
  } | null>(null);
  let contextMenu = $state<{
    x: number;
    y: number;
    items: SidebarFolderMenuItem[];
    /** The row it is open for, as the agent's `elements` names it: `note "<id>"`, `folder "<path>"`. */
    openFor: string;
  } | null>(null);

  function openCreateFolder(parent: string): void {
    // Without a usable vault the dialog can only fail, however often it is retried.
    if (vaultAvailability.unavailable) return;
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

  function requestFolderRename(path: string): void {
    renameRequest = { path, nonce: Date.now() };
  }

  function requestNoteRename(id: string): void {
    noteRenameRequest = { id, nonce: Date.now() };
  }

  function showFolderContextMenu(path: string, x: number, y: number): void {
    contextMenu = {
      x,
      y,
      items: lockedWhileVaultUnusable(
        folderMenuItems({
          newNote: () => options.onNewNoteInFolder(path),
          newFolder: () => openCreateFolder(path),
          rename: () => requestFolderRename(path),
          move: () => openMoveFolderPicker(path),
          remove: () => confirmDeleteSidebarFolder(path, options),
        }),
      ),
      openFor: `folder "${path}"`,
    };
  }

  function showNoteContextMenu(id: string, x: number, y: number): void {
    contextMenu = {
      x,
      y,
      items: lockedWhileVaultUnusable(
        noteMenuItems({
          rename: () => requestNoteRename(id),
          move: () => openMoveNotePicker(id),
          remove: () => confirmDeleteSidebarNote(id, options),
        }),
      ),
      openFor: `note "${id}"`,
    };
  }

  function closeContextMenu(): void {
    contextMenu = null;
  }

  function openMoveNotePicker(noteId: string): void {
    folderPicker = {
      title: { path: 'folders.movePickerHeading' },
      excludePaths: [],
      onpick: (target) => moveNoteFromPicker(noteId, target),
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
      onpick: (target) => moveFolderFromPicker(folderPath, target),
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
    requestFolderRename,
    requestNoteRename,
    renameFolder: (path: string, newName: string) => renameSidebarFolder(path, newName, options),
    renameNote: (id: string, newTitle: string) => renameSidebarNote(id, newTitle, options),
    closeFolderPicker,
    moveNoteToFolder: (noteId: string, folderPath: string) =>
      moveSidebarNoteToFolder(noteId, folderPath, options),
    moveNoteToRoot: (noteId: string) => moveSidebarNoteToFolder(noteId, '', options),
    moveFolder: (folderPath: string, targetPath: string) =>
      moveSidebarFolder(folderPath, targetPath, options),
    moveFolderToRoot: (folderPath: string) => moveSidebarFolder(folderPath, '', options),
  };
}
