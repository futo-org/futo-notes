import { isTauri } from '$lib/platform';
import { getConfig, saveConfig } from '$lib/platform/tauri';
import { getAllNotes, whenNotesReady } from '$features/notes/notes.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

export const SIDEBAR_COLLAPSED_KEY = 'futo-notes:sidebarCollapsed';

export interface TabsPersistenceDeps {
  initialNoteId: string | null;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
}

// Restores sidebar chrome + persisted tabs, then installs the tab persister.
// The persisted tabs are validated only AFTER the initial vault scan
// (whenNotesReady) so a stale id can't resurrect a note; the returned disposer
// is safe to call before any async step finishes (it just detaches the
// persister), which is what keeps a fast unmount from hydrating a torn-down
// shell.
export function startTabsPersistence(deps: TabsPersistenceDeps): () => void {
  let disposed = false;

  restoreCollapsedState(deps.setSidebarCollapsed);

  void (async () => {
    let persistedTabs = null;
    if (isTauri) {
      try {
        const config = await getConfig();
        if (disposed) return;
        if (typeof config.sidebarWidth === 'number') deps.setSidebarWidth(config.sidebarWidth);
        persistedTabs = config.openTabs ?? null;
      } catch (error) {
        console.warn('Failed to load tab config:', error);
      }
    }

    await whenNotesReady();
    if (disposed) return;

    const validIds = new Set(getAllNotes().map((note) => note.id));
    tabsStore.hydrate(persistedTabs, (id) => validIds.has(id), deps.initialNoteId);
    if (disposed) return;

    if (isTauri) {
      tabsStore.setPersister((snapshot) => {
        void saveConfig({ openTabs: snapshot }).catch((error) =>
          console.warn('Failed to persist tabs:', error),
        );
      });
    }
  })();

  return () => {
    disposed = true;
    tabsStore.setPersister(null);
  };
}

function restoreCollapsedState(setSidebarCollapsed: (collapsed: boolean) => void): void {
  try {
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
  } catch {
    // localStorage can be unavailable (private mode); default to expanded.
  }
}
