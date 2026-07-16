import { getPlatformFS, isTauri } from '$lib/platform';
import { idLeaf, safeNotePath } from '$lib/platform/pathSafety';
import { getConfig } from '$lib/platform/tauri';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { deleteNote as deleteNoteFromVault, moveNote } from '$features/notes/notes.svelte';

export interface CurrentNoteActionsDeps {
  getActiveNoteId: () => string | null;
  showToast: (message: string) => void;
  onMoved: (fromId: string, toId: string, title: string) => void;
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
    deps.showToast('coming soon');
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
      deps.showToast('Path copied');
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
    const fromId = deps.getActiveNoteId();
    if (!fromId) return;
    const leaf = idLeaf(fromId);
    const wantedId = folderPath ? `${folderPath}/${leaf}` : leaf;
    if (wantedId === fromId) return;
    const result = await moveNote(fromId, wantedId);
    deps.onMoved(fromId, result.id, idLeaf(result.id));
    deps.showToast(`Moved to ${folderPath || 'Notes'}`);
  }

  async function deleteCurrentNote(): Promise<void> {
    closeMenu();
    const id = deps.getActiveNoteId();
    if (!id) return;
    const confirmed = await confirmDialog('Delete this note? This action cannot be undone.', {
      title: 'Delete note',
      kind: 'warning',
    });
    if (!confirmed) return;
    deps.onDeleteConfirmed();
    await deleteNoteFromVault(id);
    deps.showToast('Note deleted');
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
