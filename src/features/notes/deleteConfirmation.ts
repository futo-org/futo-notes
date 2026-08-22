import { isTauri } from '$lib/platform';
import { vaultStatus } from '$lib/platform/tauri';

/**
 * Desktop normally routes a delete through the OS trash, so "cannot be undone"
 * means "not from inside this app". Some vaults have no trash reachable at all —
 * a folder picked inside a Flatpak lives on the XDG document portal, and the
 * Trash portal declines those paths — and there the confirmation must not imply a
 * recovery that does not exist.
 */
const RECOVERABLE = 'This action cannot be undone.';
const PERMANENT = 'This deletes the file for good — it does not go to the trash.';
const FOLDER = 'Delete this folder? Notes inside it will be moved to the parent folder.';
const FOLDER_PERMANENT = `${FOLDER} Anything else inside it is deleted for good.`;

let permanence: Promise<{ notes: boolean; folders: boolean }> | null = null;

// One answer per session: the active vault cannot change without a process
// restart. A failed read reports recoverable — the milder claim, and true for
// the default vault.
function deletePermanence(): Promise<{ notes: boolean; folders: boolean }> {
  permanence ??= vaultStatus()
    .then((status) => ({
      notes: status.deletesArePermanent,
      folders: status.folderDeletesArePermanent,
    }))
    .catch((error) => {
      console.warn('Failed to read vault delete policy:', error);
      return { notes: false, folders: false };
    });
  return permanence;
}

/** The sentence a note-delete confirmation ends with. */
export async function noteDeleteWarning(): Promise<string> {
  if (!isTauri) return RECOVERABLE;
  return (await deletePermanence()).notes ? PERMANENT : RECOVERABLE;
}

/**
 * The folder-delete confirmation. Notes are always moved to the parent first —
 * what varies is whether the emptied shell (and any stray non-note files in it)
 * can go to the trash: the Trash portal declines directories, so in a Flatpak it
 * cannot, and the dialog must say so.
 */
export async function folderDeleteWarning(): Promise<string> {
  if (!isTauri) return FOLDER;
  return (await deletePermanence()).folders ? FOLDER_PERMANENT : FOLDER;
}
