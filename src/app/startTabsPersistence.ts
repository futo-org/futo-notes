import { getAllNotes, whenNotesReady } from '$features/notes/notes.svelte';
import { hasFileSystem, isDesktop } from '$lib/platform';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

interface TabsPersistenceOptions {
  initialNoteId: string | null;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setGraphSidebarWidth: (width: number) => void;
}

export function startTabsPersistence({
  initialNoteId,
  setSidebarCollapsed,
  setSidebarWidth,
  setGraphSidebarWidth,
}: TabsPersistenceOptions): () => void {
  let persistTimer: number | null = null;
  let disposed = false;

  if (!isDesktop) {
    tabsStore.hydrate(null, () => true, initialNoteId);
    return () => tabsStore.setPersister(null);
  }

  if (localStorage.getItem('futo-notes:sidebarCollapsed') === 'true') {
    setSidebarCollapsed(true);
  }

  // Validate persisted tabs only after the initial vault scan is complete.
  void Promise.all([
    import('$lib/platform/tauri').then(({ getConfig, saveConfig }) =>
      getConfig().then((config) => ({ config, saveConfig })),
    ),
    whenNotesReady(),
  ])
    .then(([{ config, saveConfig }]) => {
      if (disposed) return;
      if (config.sidebarWidth) setSidebarWidth(config.sidebarWidth);
      if (config.graphSidebarWidth) setGraphSidebarWidth(config.graphSidebarWidth);

      const noteIds = new Set((hasFileSystem ? getAllNotes() : []).map((note) => note.id));
      tabsStore.hydrate(config.openTabs ?? null, (id) => noteIds.has(id), initialNoteId);
      tabsStore.setPersister((snapshot) => {
        if (persistTimer !== null) clearTimeout(persistTimer);
        persistTimer = window.setTimeout(() => {
          persistTimer = null;
          void saveConfig({ openTabs: snapshot }).catch((error) =>
            console.warn('Failed to persist open tabs:', error),
          );
        }, 250);
      });
    })
    .catch((error) => {
      if (disposed) return;
      console.warn('[tabs] hydrate path failed, falling back without persister:', error);
      const sidebarWidth = Number(localStorage.getItem('futo-notes:sidebarWidth')) || 280;
      const graphSidebarWidth = Number(localStorage.getItem('futo-notes:graphSidebarWidth')) || 320;
      setSidebarWidth(sidebarWidth);
      setGraphSidebarWidth(graphSidebarWidth);
      tabsStore.hydrate(null, () => true, initialNoteId);
    });

  return () => {
    if (disposed) return;
    disposed = true;
    if (persistTimer !== null) clearTimeout(persistTimer);
    tabsStore.setPersister(null);
  };
}
