import { idParent } from '$lib/platform/pathSafety';

import {
  clearDragHoverExpanded,
  isFolderOpen,
  setDragHoverExpanded,
} from './folderExpansion.svelte';
import { createLinuxDragMirror } from './linuxDragMirror';

const NOTE_MIME = 'application/futo-note-id';
const FOLDER_MIME = 'application/futo-folder-path';

interface FolderTreeDragCallbacks {
  onNoteDragStart: (id: string, event: DragEvent) => void;
  onFolderDragStart: (path: string, event: DragEvent) => void;
  onDropNoteOnFolder: (noteId: string, folderPath: string) => void;
  onDropFolderOnFolder: (folderPath: string, targetPath: string) => void;
  onDropNoteOnRoot: (noteId: string) => void;
  onDropFolderOnRoot: (folderPath: string) => void;
}

export function createFolderTreeDrag(callbacks: FolderTreeDragCallbacks) {
  let dropTarget = $state<string | null>(null);
  let sourceParent: string | null = null;
  let sourceFolderPath: string | null = null;
  let sourceNoteId: string | null = null;
  let hoverTimer: number | null = null;
  let hoveredFolder: string | null = null;
  const dragMirror = createLinuxDragMirror();

  function clearHoverTimer(): void {
    if (hoverTimer !== null) window.clearTimeout(hoverTimer);
    hoverTimer = null;
    hoveredFolder = null;
  }

  function clearDragState(): void {
    clearHoverTimer();
    dropTarget = null;
    sourceParent = null;
    sourceFolderPath = null;
    sourceNoteId = null;
    clearDragHoverExpanded();
  }

  function carriesNoteOrFolder(dataTransfer: DataTransfer | null): boolean {
    if (sourceNoteId !== null || sourceFolderPath !== null) return true;
    return Boolean(
      dataTransfer &&
      (dataTransfer.types.includes(NOTE_MIME) || dataTransfer.types.includes(FOLDER_MIME)),
    );
  }

  function setDropTarget(path: string): void {
    const isInvalidFolderTarget =
      sourceFolderPath !== null &&
      (path === sourceFolderPath || path.startsWith(`${sourceFolderPath}/`));
    const next = isInvalidFolderTarget || sourceParent === path ? null : path;
    if (dropTarget !== next) dropTarget = next;
  }

  function handleNoteDragStart(event: DragEvent, id: string): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(NOTE_MIME, id);
    event.dataTransfer.effectAllowed = 'move';
    sourceParent = idParent(id);
    sourceFolderPath = null;
    sourceNoteId = id;
    dragMirror.setDragImage(event);
    callbacks.onNoteDragStart(id, event);
  }

  function handleFolderDragStart(event: DragEvent, path: string): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(FOLDER_MIME, path);
    event.dataTransfer.effectAllowed = 'move';
    sourceParent = idParent(path);
    sourceFolderPath = path;
    sourceNoteId = null;
    dragMirror.setDragImage(event);
    callbacks.onFolderDragStart(path, event);
  }

  function handleDragEnd(): void {
    clearDragState();
    dragMirror.teardown();
  }

  function handleFolderDragOver(event: DragEvent, path: string): void {
    if (!carriesNoteOrFolder(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setDropTarget(path);

    if (hoveredFolder === path) return;
    clearHoverTimer();
    hoveredFolder = path;
    if (!isFolderOpen(path)) {
      hoverTimer = window.setTimeout(() => {
        setDragHoverExpanded(path, true);
        hoverTimer = null;
      }, 600);
    }
  }

  function handleNoteDragOver(event: DragEvent, parentPath: string): void {
    if (!carriesNoteOrFolder(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setDropTarget(parentPath);
    clearHoverTimer();
  }

  function readDragSources(dataTransfer: DataTransfer): { noteId: string; folderPath: string } {
    return {
      noteId: dataTransfer.getData(NOTE_MIME) || sourceNoteId || '',
      folderPath: dataTransfer.getData(FOLDER_MIME) || sourceFolderPath || '',
    };
  }

  function handleRowDrop(event: DragEvent, target: string): void {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.stopPropagation();
    const { noteId, folderPath } = readDragSources(event.dataTransfer);
    clearDragState();
    dragMirror.teardown();

    if (noteId) {
      if (target) callbacks.onDropNoteOnFolder(noteId, target);
      else callbacks.onDropNoteOnRoot(noteId);
    } else if (folderPath) {
      if (folderPath === target || target.startsWith(`${folderPath}/`)) return;
      if (target) callbacks.onDropFolderOnFolder(folderPath, target);
      else if (folderPath.includes('/')) callbacks.onDropFolderOnRoot(folderPath);
    }
  }

  function handleRootDragOver(event: DragEvent): void {
    if (!carriesNoteOrFolder(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setDropTarget('');
  }

  function handleRootDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (!related || (event.currentTarget as Node).contains(related)) return;
    dropTarget = null;
    clearHoverTimer();
  }

  function destroy(): void {
    clearHoverTimer();
    dragMirror.teardown();
  }

  return {
    get dropTarget() {
      return dropTarget;
    },
    handleNoteDragStart,
    handleFolderDragStart,
    handleDragEnd,
    handleFolderDragOver,
    handleNoteDragOver,
    handleRowDrop,
    handleRootDragOver,
    handleRootDragLeave,
    clearHoverTimer,
    destroy,
  };
}
