import { beforeEach, expect, it, vi } from 'vitest';
import { tabsStore } from '$features/tabs/tabsStore.svelte';
import { createTabRenames } from './createTabRenames';

beforeEach(() => {
  tabsStore.__resetForTests();
});

/* A sidebar rename of the open note used to rename its tab directly, ahead of the
 * session, which still held the old id: the tab named a note the editor did not hold. */
it("leaves the open note's tab to its session, and renames every other tab", () => {
  tabsStore.openNote('Open', 'current');
  tabsStore.openNote('Other', 'background');
  const loaded = vi.fn();
  const renameTabs = createTabRenames({ attachedNoteId: () => 'Open', loaded });

  renameTabs('Open', 'Open renamed');
  renameTabs('Other', 'Other renamed');

  expect(tabsStore.tabs.map((tab) => tab.noteId)).toEqual(['Open', 'Other renamed']);
  expect(loaded).not.toHaveBeenCalled();
});

it('marks the active tab loaded when a rename the session followed moves it', () => {
  tabsStore.openNote('Old', 'current');
  const loaded = vi.fn();
  // The editor's attachment moved already: it holds the new id.
  const renameTabs = createTabRenames({ attachedNoteId: () => 'New', loaded });

  renameTabs('Old', 'New');

  expect(tabsStore.activeNoteId).toBe('New');
  expect(loaded).toHaveBeenCalledExactlyOnceWith('New');
});

/* Switching A -> B: the host released A, but the loader has not recorded B yet, so the
 * session still names A. A sidebar rename of A then has no report coming. */
it('renames the tabs of a note the editor released, though the session still names it', () => {
  tabsStore.openNote('A', 'current');
  tabsStore.openNote('A', 'background');
  const renameTabs = createTabRenames({ attachedNoteId: () => null, loaded: vi.fn() });

  renameTabs('A', 'A renamed');

  expect(tabsStore.tabs.map((tab) => tab.noteId)).toEqual(['A renamed', 'A renamed']);
});
