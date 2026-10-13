import { tabsStore } from '$features/tabs/tabsStore.svelte';
import { beginNoteSwitch, endNoteSwitch, markNoteSwitch } from '$shared/perf/noteSwitchTimeline';

export interface TabNoteTransitionDeps {
  loadNote: (id: string | null) => Promise<void>;
  getNoteBody: () => HTMLElement | undefined;
  /** The open note is still streaming in (progressiveLoad.ts), so the body is
   * not yet as tall as the note will be. */
  isNoteStreaming: () => boolean;
}

// Owns switching the open note when the active tab changes: save the outgoing
// tab's scroll position, load the incoming note, then restore that tab's scroll
// (tabs.md — per-tab scroll persists). loadNote resets scrollTop to 0, so the
// restore runs after it, on the next frame.
//
// A large note opens progressively: one screen of it first, the rest in idle
// slices. Set while the body is still shorter than the saved offset, the
// browser clamped the restore to that partial height, and the view then rode
// the bottom of the note as the rest appended — a note left at 50 000px came
// back at 148 000px. So the restore waits at the top, a frame at a time, until
// the note has streamed far enough to reach it (or has finished streaming). If
// the reader scrolls first, the position is theirs and the restore is dropped.
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
    const stale = () => version !== transitionVersion || tabsStore.activeTabId !== nextTabId;
    beginNoteSwitch(nextNoteId);

    if (previousTabId && previousTabId !== nextTabId) {
      const body = deps.getNoteBody();
      if (body) tabsStore.setTabState(previousTabId, { scroll: body.scrollTop });
    }
    try {
      await deps.loadNote(nextNoteId);
    } catch {
      if (version === transitionVersion && previousTabId) {
        tabsStore.restoreAfterFailedNavigation(previousTabId, loadedNoteId);
      }
      endNoteSwitch();
      return;
    }
    if (stale()) return;
    previousTabId = nextTabId;
    loadedNoteId = nextNoteId;

    if (savedScroll > 0) {
      // Where the view waits for the stream; moved from there, it is the reader's.
      let parkedAt: number | null = null;
      const restore = () => {
        if (stale()) return;
        const body = deps.getNoteBody();
        if (body && (parkedAt === null || body.scrollTop === parkedAt)) {
          const reachable = body.scrollHeight - body.clientHeight >= savedScroll;
          if (!reachable && deps.isNoteStreaming()) {
            parkedAt = body.scrollTop;
            requestAnimationFrame(restore);
            return;
          }
          body.scrollTop = savedScroll;
        }
        markNoteSwitch('scrollRestored');
        endNoteSwitch();
      };
      requestAnimationFrame(() => requestAnimationFrame(restore));
      return;
    }
    endNoteSwitch();
  }

  return {
    transition,
    setLoadedNoteId(noteId: string | null): void {
      transitionVersion += 1;
      loadedNoteId = noteId;
    },
  };
}
