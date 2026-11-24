import { tabsStore } from '$features/tabs/tabsStore.svelte';
import { beginNoteSwitch, endNoteSwitch, markNoteSwitch } from '$shared/perf/noteSwitchTimeline';

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
  /** Where the newest switch, still loading, is going: a tab that asks for the note it
   *  had meanwhile (a second click back) needs a load of its own. */
  let destination: { tabId: string; noteId: string | null } | null = null;
  let transitionVersion = 0;
  // The switch whose scroll restore is still to run: it ends there, not at the load.
  let restoringVersion: number | null = null;
  let waiters: Array<(failure?: unknown) => void> = [];

  function answerWaiters(failure?: unknown): void {
    for (const resolve of waiters) resolve(failure);
    waiters = [];
  }

  const caughtUp = (): boolean =>
    restoringVersion !== transitionVersion &&
    previousTabId === tabsStore.activeTabId &&
    loadedNoteId === tabsStore.activeNoteId;

  async function transition(
    nextTabId: string,
    nextNoteId: string | null,
    savedScroll: number,
  ): Promise<void> {
    await switchTo(nextTabId, nextNoteId, savedScroll);
    if (caughtUp()) answerWaiters();
  }

  async function switchTo(
    nextTabId: string,
    nextNoteId: string | null,
    savedScroll: number,
  ): Promise<void> {
    const target = destination ?? { tabId: previousTabId, noteId: loadedNoteId };
    if (target.tabId === nextTabId && target.noteId === nextNoteId) return;
    const version = ++transitionVersion;
    destination = { tabId: nextTabId, noteId: nextNoteId };
    const stale = () => version !== transitionVersion || tabsStore.activeTabId !== nextTabId;
    beginNoteSwitch(nextNoteId);

    if (previousTabId && previousTabId !== nextTabId) {
      const body = deps.getNoteBody();
      if (body) tabsStore.setTabState(previousTabId, { scroll: body.scrollTop });
    }
    try {
      await deps.loadNote(nextNoteId);
    } catch (error) {
      if (version === transitionVersion) destination = null;
      if (version === transitionVersion && previousTabId) {
        tabsStore.restoreAfterFailedNavigation(previousTabId, loadedNoteId);
        answerWaiters(error);
      }
      endNoteSwitch();
      return;
    }
    if (version === transitionVersion) destination = null;
    if (stale()) return;
    previousTabId = nextTabId;
    loadedNoteId = nextNoteId;

    if (savedScroll > 0) {
      const restore = () => {
        if (!stale()) {
          const body = deps.getNoteBody();
          if (body) body.scrollTop = savedScroll;
          markNoteSwitch('scrollRestored');
          endNoteSwitch();
        }
        if (restoringVersion === version) restoringVersion = null;
        if (caughtUp()) answerWaiters();
      };
      restoringVersion = version;
      requestAnimationFrame(() => requestAnimationFrame(restore));
      return;
    }
    endNoteSwitch();
  }

  return {
    transition,
    /**
     * Nothing once the loaded note is the active tab's and its scroll is restored; until
     * then a promise that resolves when a transition lands there. Changing tabs is
     * synchronous and the load is not, so this is what "the note is open" waits on. It
     * resolves with the error instead when the outgoing draft could not be saved and its
     * tab came back.
     */
    settled(): Promise<unknown> | undefined {
      if (caughtUp()) return undefined;
      return new Promise((resolve) => waiters.push(resolve));
    },
    setLoadedNoteId(noteId: string | null): void {
      transitionVersion += 1;
      destination = null;
      loadedNoteId = noteId;
    },
  };
}
