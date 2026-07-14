import type MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
import { tabsStore } from '$features/tabs/tabsStore.svelte';

interface TabNoteTransitionOptions {
  getEditor: () => ReturnType<typeof MarkdownEditor> | null;
  getNoteBody: () => HTMLElement | undefined;
  getCurrentNoteId: () => string | null;
  loadNote: (id: string | null) => Promise<void>;
}

export function createTabNoteTransition(options: TabNoteTransitionOptions) {
  let previousNoteId: string | null | undefined;
  let previousTabId: string | null = null;

  function update(currentNoteId: string | null): void {
    const currentTabId = tabsStore.activeTabId;
    if (previousNoteId === currentNoteId && previousTabId === currentTabId) return;

    const editor = options.getEditor();
    if (previousTabId && previousTabId !== currentTabId && editor) {
      const selection = editor.getSelection?.();
      const scroll = options.getNoteBody()?.scrollTop ?? 0;
      tabsStore.setTabState(
        previousTabId,
        selection ? { scroll, selFrom: selection.from, selTo: selection.to } : undefined,
      );
    }

    const incomingTabId = currentTabId;
    const incomingState = tabsStore.tabs.find((tab) => tab.id === incomingTabId)?.state;
    const incomingNoteId = currentNoteId;
    previousNoteId = currentNoteId;
    previousTabId = currentTabId;

    void options.loadNote(currentNoteId).then(() => {
      if (!incomingState) return;
      if (tabsStore.activeTabId !== incomingTabId) return;
      if (incomingNoteId !== options.getCurrentNoteId()) return;

      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (tabsStore.activeTabId !== incomingTabId) return;
          options.getEditor()?.setSelection?.(incomingState.selFrom, incomingState.selTo);
          const noteBody = options.getNoteBody();
          if (noteBody) noteBody.scrollTop = incomingState.scroll;
        }),
      );
    });
  }

  function handleNoteRenamed(savedOriginalId: string | null, realId: string): void {
    const oldKey = savedOriginalId ?? 'new';
    const activeTab = tabsStore.activeTab;
    if (activeTab.noteId === oldKey) {
      previousNoteId = realId;
      previousTabId = activeTab.id;
    }
    for (const tab of tabsStore.tabs) {
      if (tab.noteId === oldKey) tabsStore.replaceTabNoteId(tab.id, realId);
    }
  }

  return {
    get previousNoteId() {
      return previousNoteId ?? null;
    },
    setPreviousNoteId(id: string | null | undefined) {
      previousNoteId = id;
    },
    update,
    handleNoteRenamed,
  };
}
