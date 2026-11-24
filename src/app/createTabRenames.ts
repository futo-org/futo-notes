import { tabsStore } from '$features/tabs/tabsStore.svelte';

interface TabRenameDeps {
  /** The note the editor's host holds, as it last reported it; null mid-switch. */
  attachedNoteId: () => string | null;
  /** The tab transition's loaded note (`setLoadedNoteId`). */
  loaded: (id: string) => void;
}

/**
 * The one tab policy for a note whose id changed, whoever reports it (the session, a
 * sidebar or menu workflow, a sync cycle): the tabs showing it follow, except while the
 * editor's attachment is still on it. That note's tab follows its session, which follows
 * the editor's report (`onnote`), so a tab never names a note the editor does not hold;
 * a note the editor already released has no report coming, so its tabs follow here.
 */
export function createTabRenames(deps: TabRenameDeps) {
  return function renameTabs(fromId: string, toId: string): void {
    if (fromId === deps.attachedNoteId()) return;
    tabsStore.applyRename(fromId, toId);
    // A rename landing mid-switch would otherwise stamp a note the transition never
    // loaded, and the next click on that row no-ops.
    if (tabsStore.activeNoteId === toId) deps.loaded(toId);
  };
}
