import { vaultAvailability } from '$features/storage/vaultAvailability.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

// Every way to start a note lands here: the New button, Cmd/Ctrl+N, the app
// menu, a folder's "New note". A note is written on its first save, so with no
// usable vault the user would type into a note that can only be lost.
export function createNewNote(folder = ''): void {
  if (vaultAvailability.unavailable) return;
  const tab = tabsStore.openNote('new', 'current');
  tabsStore.setPendingFolder(tab.id, folder || null);
}
