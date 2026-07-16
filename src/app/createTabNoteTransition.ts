import { tabsStore } from '$features/tabs/tabsStore.svelte';

export interface TabNoteTransitionDeps {
  loadNote: (id: string | null) => Promise<void>;
  getNoteBody: () => HTMLElement | undefined;
}

// Owns switching the open note when the active tab changes: save the outgoing
// tab's scroll position, load the incoming note, then restore that tab's scroll
// (tabs.md — per-tab scroll persists). loadNote resets scrollTop to 0, so the
// restore runs after it, on the next frame.
export function createTabNoteTransition(deps: TabNoteTransitionDeps) {
  let previousTabId: string | null = null;
  let loadedNoteId: string | null = null;
  let transitionVersion = 0;

  async function transition(
    nextTabId: string,
    nextNoteId: string | null,
    savedScroll: number,
  ): Promise<void> {
    if (previousTabId === nextTabId && loadedNoteId === nextNoteId) return;
    const version = ++transitionVersion;

    if (previousTabId && previousTabId !== nextTabId) {
      const body = deps.getNoteBody();
      if (body) tabsStore.setTabState(previousTabId, { scroll: body.scrollTop });
    }
    previousTabId = nextTabId;

    await deps.loadNote(nextNoteId);
    if (version !== transitionVersion || tabsStore.activeTabId !== nextTabId) return;
    loadedNoteId = nextNoteId;

    if (savedScroll > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (version !== transitionVersion || tabsStore.activeTabId !== nextTabId) return;
          const body = deps.getNoteBody();
          if (body) body.scrollTop = savedScroll;
        });
      });
    }
  }

  return {
    transition,
    setLoadedNoteId(noteId: string | null): void {
      transitionVersion += 1;
      loadedNoteId = noteId;
    },
  };
}
