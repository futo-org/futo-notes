import { createFolder, validateNewFolderName } from '$features/folders/folderOperations';
import {
  collectSiblingFolders,
  confirmDeleteSidebarFolder,
  confirmDeleteSidebarNote,
  moveSidebarFolder,
  moveSidebarFolderToRoot,
  moveSidebarNote,
  moveSidebarNoteToFolder,
  moveSidebarNoteToRoot,
  refreshSidebarFolders,
  renameSidebarFolder,
} from './sidebarFolderMutations';

export interface SidebarFolderMenuItem {
  label: string;
  destructive?: boolean;
  onclick: () => void;
}

interface SidebarFolderWorkflowOptions {
  getActiveNoteId: () => string | null;
  onSelect: (id: string) => void;
  onNewNoteInFolder: (folderPath: string) => void;
}

export function createSidebarFolderWorkflows(options: SidebarFolderWorkflowOptions) {
  let isCreateFolderOpen = $state(false);
  let createFolderParent = $state('');
  let renameRequest = $state<{ path: string; nonce: number } | null>(null);
  let folderPicker = $state<{
    title: string;
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

  function validateCreateFolder(name: string): string | null {
    return validateNewFolderName(
      createFolderParent,
      name.trim(),
      collectSiblingFolders(createFolderParent),
    );
  }

  async function submitCreateFolder(name: string): Promise<string | null> {
    const result = await createFolder(
      createFolderParent,
      name.trim(),
      collectSiblingFolders(createFolderParent),
    );
    if (!result.ok) return result.error ?? 'Failed to create folder';
    closeCreateFolder();
    await refreshSidebarFolders();
    return null;
  }

  function showFolderContextMenu(path: string, x: number, y: number): void {
    contextMenu = {
      x,
      y,
      items: [
        { label: 'New Note', onclick: () => options.onNewNoteInFolder(path) },
        { label: 'New Folder', onclick: () => openCreateFolder(path) },
        {
          label: 'Rename',
          onclick: () => {
            renameRequest = { path, nonce: Date.now() };
          },
        },
        {
          label: 'Delete',
          destructive: true,
          onclick: () => void confirmDeleteSidebarFolder(path, options),
        },
      ],
    };
  }

  function showNoteContextMenu(id: string, x: number, y: number): void {
    contextMenu = {
      x,
      y,
      items: [
        { label: 'Move to folder', onclick: () => openMoveNotePicker(id) },
        {
          label: 'Delete',
          destructive: true,
          onclick: () => void confirmDeleteSidebarNote(id),
        },
      ],
    };
  }

  function closeContextMenu(): void {
    contextMenu = null;
  }

  function openMoveNotePicker(noteId: string): void {
    folderPicker = {
      title: 'Move to folder',
      excludePaths: [],
      onpick: (target) => void moveNoteFromPicker(noteId, target),
    };
  }

  async function moveNoteFromPicker(noteId: string, target: string): Promise<void> {
    await moveSidebarNote(noteId, target);
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
    renameFolder: renameSidebarFolder,
    closeFolderPicker,
    moveNoteToFolder: moveSidebarNoteToFolder,
    moveNoteToRoot: moveSidebarNoteToRoot,
    moveFolder: moveSidebarFolder,
    moveFolderToRoot: moveSidebarFolderToRoot,
  };
}
