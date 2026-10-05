import { isTauri } from '$lib/platform';
import { loadVaultAvailability } from '$features/storage/vaultAvailability.svelte';
import type { LocalizedMessage } from '$shared/localization';

/**
 * Desktop normally routes a delete through the OS trash, so "cannot be undone"
 * means "not from inside this app". Some vaults have no trash reachable at all —
 * a folder picked inside a Flatpak lives on the XDG document portal, and the
 * Trash portal declines those paths — and there the confirmation must not imply a
 * recovery that does not exist.
 */
// Read from the launch's one vault status — the active vault cannot change
// without a process restart. A failed read reports recoverable — the milder
// claim, and true for the default vault.
async function deletePermanence(): Promise<{ notes: boolean; folders: boolean }> {
  try {
    const status = await loadVaultAvailability();
    return { notes: status.deletesArePermanent, folders: status.folderDeletesArePermanent };
  } catch (error) {
    console.warn('Failed to read vault delete policy:', error);
    return { notes: false, folders: false };
  }
}

/** The sentence a note-delete confirmation ends with. */
export async function noteDeleteIsPermanent(): Promise<boolean> {
  if (!isTauri) return false;
  return (await deletePermanence()).notes;
}

/**
 * The folder-delete confirmation. Notes are always moved to the parent first —
 * what varies is whether the emptied shell (and any stray non-note files in it)
 * can go to the trash: the Trash portal declines directories, so in a Flatpak it
 * cannot, and the dialog must say so.
 */
export async function folderDeleteConfirmation(): Promise<LocalizedMessage> {
  if (!isTauri) return { path: 'folders.delete.recoverableConfirmation' };
  return (await deletePermanence()).folders
    ? { path: 'folders.delete.permanentConfirmation' }
    : { path: 'folders.delete.recoverableConfirmation' };
}
