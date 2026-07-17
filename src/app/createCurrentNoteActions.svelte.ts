import { deleteNote, moveNote } from '$features/notes/notes.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';
import { getPlatformFS } from '$lib/platform';

interface CurrentNoteActionOptions {
  getNoteId: () => string | null;
  getOriginalId: () => string | null;
  cancelSession: () => void;
  notifySaved: () => void;
  showToast: (message: string) => void;
}

export function createCurrentNoteActions(options: CurrentNoteActionOptions) {
  let menuOpen = $state(false);
  let deleteConfirmationOpen = $state(false);
  let movePickerNoteId = $state<string | null>(null);

  function requestDelete(): void {
    deleteConfirmationOpen = true;
  }

  function cancelDelete(): void {
    deleteConfirmationOpen = false;
  }

  async function deleteCurrentNote(): Promise<void> {
    deleteConfirmationOpen = false;
    menuOpen = false;
    const id = options.getOriginalId();
    if (!id) return;
    options.cancelSession();
    await deleteNote(id);
    options.notifySaved();
    options.showToast('Note deleted');
  }

  function openMovePicker(): void {
    const id = options.getNoteId();
    if (!id || id === 'new') return;
    movePickerNoteId = id;
  }

  function closeMovePicker(): void {
    movePickerNoteId = null;
  }

  async function moveCurrentNote(target: string): Promise<void> {
    const id = movePickerNoteId;
    closeMovePicker();
    if (!id) return;
    const components = id.split('/');
    const leaf = components[components.length - 1];
    const newId = target ? `${target}/${leaf}` : leaf;
    if (newId === id) return;

    try {
      const result = await moveNote(id, newId);
      if (result.id !== id) tabsStore.applyRename(id, result.id);
      options.showToast(target ? `Moved to ${target}` : 'Moved to Notes');
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : 'Move failed');
    }
  }

  async function copyPath(): Promise<void> {
    const id = options.getNoteId();
    if (!id || id === 'new') return;
    try {
      const { getConfig } = await import('$lib/platform/tauri');
      const config = await getConfig();
      await (await getPlatformFS()).writeClipboardText(`${config.notesDir}/${id}.md`);
      options.showToast('Path copied');
    } catch {
      options.showToast('Failed to copy path');
    }
  }

  function closeTransientUi(): void {
    menuOpen = false;
    deleteConfirmationOpen = false;
  }

  return {
    get menuOpen() {
      return menuOpen;
    },
    set menuOpen(value: boolean) {
      menuOpen = value;
    },
    get deleteConfirmationOpen() {
      return deleteConfirmationOpen;
    },
    get movePickerNoteId() {
      return movePickerNoteId;
    },
    requestDelete,
    cancelDelete,
    deleteCurrentNote,
    openMovePicker,
    closeMovePicker,
    moveCurrentNote,
    copyPath,
    closeTransientUi,
  };
}
