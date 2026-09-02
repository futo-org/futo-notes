import { getPlatformFS, isTauri } from '$lib/platform';
import { idLeaf, safeNotePath } from '$lib/platform/pathSafety';
import { getConfig } from '$lib/platform/tauri';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { noteDeleteIsPermanent } from '$features/notes/deleteConfirmation';
import { pickNoteForAction } from '$features/notes/noteActionTarget';
import { deleteNote as deleteNoteFromVault, moveNote } from '$features/notes/notes.svelte';
import { localizedText } from '$shared/localization';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';

export interface CurrentNoteActionsDeps {
  getActiveNoteId: () => string | null;
  runWithActiveNoteLock: <T>(operation: () => Promise<T>) => Promise<T>;
  showToast: (message: ToastMessage) => void;
  onMoved: (fromId: string, toId: string, title: string) => void;
  onDeleted: (id: string) => void;
  onDeleteConfirmed: () => void;
}

// Open-note overflow menu (list.md): Graph view (stub toast), Copy file path,
// Move to folder, Delete note. Move and delete change the open note's identity,
// so they route back through the shell's rename/close callbacks rather than
// predicting the outcome here.
export function createCurrentNoteActions(deps: CurrentNoteActionsDeps) {
  let menuOpen = $state(false);
  let movePickerOpen = $state(false);

  function closeMenu(): void {
    menuOpen = false;
  }

  function graphView(): void {
    closeMenu();
    deps.showToast({ path: 'notes.graphComingSoon' });
  }

  async function copyFilePath(): Promise<void> {
    closeMenu();
    const id = deps.getActiveNoteId();
    if (!id) return;
    try {
      if (isTauri) {
        const config = await getConfig();
        await (await getPlatformFS()).writeClipboardText(safeNotePath(config.notesDir, id));
      } else {
        await navigator.clipboard?.writeText(`${id}.md`);
      }
      deps.showToast({ path: 'notes.pathCopied' });
    } catch (error) {
      console.warn('Failed to copy file path:', error);
    }
  }

  function openMovePicker(): void {
    closeMenu();
    movePickerOpen = true;
  }

  function closeMovePicker(): void {
    movePickerOpen = false;
  }

  async function moveToFolder(folderPath: string): Promise<void> {
    movePickerOpen = false;
    const pick = pickNoteForAction(deps.getActiveNoteId());
    await deps.runWithActiveNoteLock(async () => {
      const fromId = pick.resolve();
      if (!fromId) return deps.showToast({ path: 'notes.unavailable' });
      const leaf = idLeaf(fromId);
      const wantedId = folderPath ? `${folderPath}/${leaf}` : leaf;
      if (wantedId === fromId) return;
      try {
        const result = await moveNote(fromId, wantedId);
        deps.onMoved(fromId, result.id, idLeaf(result.id));
        deps.showToast(
          folderPath
            ? { path: 'notes.movedTo', arguments: { destination: folderPath } }
            : { path: 'notes.movedToNotes' },
        );
      } catch (cause) {
        console.warn('Failed to move current note', cause);
        deps.showToast({ path: 'notes.errors.moveFailed' });
      }
    });
  }

  async function deleteCurrentNote(): Promise<void> {
    closeMenu();
    const pick = pickNoteForAction(deps.getActiveNoteId());
    const confirmation = (await noteDeleteIsPermanent())
      ? localizedText('notes.delete.thisNotePermanentConfirmation')
      : localizedText('notes.delete.thisNoteRecoverableConfirmation');
    const confirmed = await confirmDialog(confirmation, {
      title: localizedText('notes.delete.heading'),
      kind: 'warning',
    });
    if (!confirmed) return;
    await deps.runWithActiveNoteLock(async () => {
      const id = pick.resolve();
      if (!id) return deps.showToast({ path: 'notes.unavailable' });
      try {
        await deleteNoteFromVault(id);
        deps.onDeleteConfirmed();
        deps.onDeleted(id);
        deps.showToast({ path: 'notes.deleted' });
      } catch (cause) {
        console.warn('Failed to delete current note', cause);
        deps.showToast({ path: 'notes.errors.deleteFailed' });
      }
    });
  }

  return {
    get menuOpen() {
      return menuOpen;
    },
    get movePickerOpen() {
      return movePickerOpen;
    },
    toggleMenu(): void {
      menuOpen = !menuOpen;
    },
    closeMenu,
    graphView,
    copyFilePath,
    openMovePicker,
    closeMovePicker,
    moveToFolder,
    deleteCurrentNote,
  };
}
