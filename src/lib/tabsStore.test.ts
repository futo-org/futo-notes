import { beforeEach, describe, expect, it } from 'vitest';
import { tabsStore, type PersistedTabs } from './tabsStore.svelte';

beforeEach(() => {
  tabsStore.__resetForTests();
});

describe('tabsStore initial state', () => {
  it('starts with one Home tab, active', () => {
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.tabs[0]!.noteId).toBeNull();
    expect(tabsStore.activeTabId).toBe(tabsStore.tabs[0]!.id);
    expect(tabsStore.activeNoteId).toBeNull();
    expect(tabsStore.isPristineSingleHome).toBe(true);
  });
});

describe('openNote', () => {
  it("'current' replaces the active tab's note", () => {
    const before = tabsStore.activeTabId;
    tabsStore.openNote('note-a', 'current');
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.activeTabId).toBe(before);
    expect(tabsStore.activeNoteId).toBe('note-a');
  });

  it("'background' appends after the active tab, leaves active unchanged", () => {
    tabsStore.openNote('first', 'current');
    const activeBefore = tabsStore.activeTabId;
    const added = tabsStore.openNote('second', 'background');
    expect(tabsStore.tabs).toHaveLength(2);
    expect(tabsStore.tabs[1]!.id).toBe(added.id);
    expect(tabsStore.activeTabId).toBe(activeBefore);
    expect(tabsStore.activeNoteId).toBe('first');
  });

  it("'foreground' appends and activates", () => {
    tabsStore.openNote('first', 'current');
    const added = tabsStore.openNote('second', 'foreground');
    expect(tabsStore.tabs).toHaveLength(2);
    expect(tabsStore.activeTabId).toBe(added.id);
    expect(tabsStore.activeNoteId).toBe('second');
  });

  it("background tab inserts immediately after the active tab, not at the end", () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.openNote('c', 'foreground');
    // tabs are [a, b, c], active=c. Re-activate b, then insert d in background.
    tabsStore.activateByIndex(1);
    tabsStore.openNote('d', 'background');
    expect(tabsStore.tabs.map((t) => t.noteId)).toEqual(['a', 'b', 'd', 'c']);
  });

  it("dedupes 'new' tab: opening 'new' twice activates the existing one", () => {
    tabsStore.openNote('a', 'current');
    const first = tabsStore.openNote('new', 'foreground');
    const second = tabsStore.openNote('new', 'foreground');
    expect(first.id).toBe(second.id);
    expect(tabsStore.tabs.filter((t) => t.noteId === 'new')).toHaveLength(1);
    expect(tabsStore.activeTabId).toBe(first.id);
  });

  it("'background' open of 'new' when one already exists leaves the active tab alone", () => {
    tabsStore.openNote('a', 'current');
    const newTab = tabsStore.openNote('new', 'background');
    // Active should still be 'a' since 'new' was opened in background.
    expect(tabsStore.activeNoteId).toBe('a');
    // Re-open in background while 'new' already exists — must NOT steal focus.
    const second = tabsStore.openNote('new', 'background');
    expect(second.id).toBe(newTab.id);
    expect(tabsStore.activeNoteId).toBe('a');
  });

  it("'current' replace clears stale pendingFolder on the active tab", () => {
    tabsStore.openNote('a', 'current');
    tabsStore.setPendingFolder(tabsStore.activeTabId, 'Projects/2026');
    expect(tabsStore.activeTab.pendingFolder).toBe('Projects/2026');
    tabsStore.openNote('b', 'current');
    expect(tabsStore.activeTab.pendingFolder).toBeUndefined();
  });
});

describe('closeTab', () => {
  it('removes the named tab and pushes onto recentlyClosed if it had a note', () => {
    tabsStore.openNote('a', 'current');
    const t = tabsStore.openNote('b', 'foreground');
    tabsStore.closeTab(t.id);
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.tabs[0]!.noteId).toBe('a');
    expect(tabsStore.recentlyClosed[0]?.noteId).toBe('b');
  });

  it('does not push Home (null noteId) onto recentlyClosed', () => {
    const home = tabsStore.activeTabId;
    tabsStore.openNote('a', 'foreground');
    tabsStore.closeTab(home);
    expect(tabsStore.recentlyClosed).toHaveLength(0);
  });

  it("does not push 'new' tab onto recentlyClosed (would dup on reopen)", () => {
    tabsStore.openNote('a', 'current');
    const newTab = tabsStore.openNote('new', 'foreground');
    tabsStore.closeTab(newTab.id);
    expect(tabsStore.recentlyClosed).toHaveLength(0);
    // Reopen should be a no-op for the 'new' tab.
    expect(tabsStore.reopenLastClosed()).toBeNull();
  });

  it('collapses the last tab to a fresh Home instead of removing it', () => {
    tabsStore.openNote('a', 'current');
    tabsStore.closeActive();
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.tabs[0]!.noteId).toBeNull();
  });

  it('after closing the active tab, picks the tab at the same index', () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    const c = tabsStore.openNote('c', 'foreground');
    // tabs are [a, b, c], active is c (index 2). Close c → active should be b.
    tabsStore.closeTab(c.id);
    expect(tabsStore.activeNoteId).toBe('b');
    // Close b (the new active, at index 1) → active should be a (last remaining).
    tabsStore.closeActive();
    expect(tabsStore.activeNoteId).toBe('a');
  });
});

describe('recentlyClosed cap', () => {
  it('keeps at most 10', () => {
    for (let i = 0; i < 15; i++) {
      const t = tabsStore.openNote(`n${i}`, 'foreground');
      tabsStore.closeTab(t.id);
    }
    expect(tabsStore.recentlyClosed).toHaveLength(10);
    // Most recently closed at index 0
    expect(tabsStore.recentlyClosed[0]!.noteId).toBe('n14');
  });
});

describe('reopenLastClosed', () => {
  it('restores last closed and activates the new tab', () => {
    tabsStore.openNote('a', 'current');
    const b = tabsStore.openNote('b', 'foreground');
    tabsStore.closeTab(b.id);
    const restored = tabsStore.reopenLastClosed();
    expect(restored).not.toBeNull();
    expect(restored!.noteId).toBe('b');
    expect(tabsStore.activeTabId).toBe(restored!.id);
    expect(tabsStore.recentlyClosed).toHaveLength(0);
  });

  it('returns null when nothing to reopen', () => {
    expect(tabsStore.reopenLastClosed()).toBeNull();
  });
});

describe('next/prev/activate', () => {
  // Building [a, b, c] requires sequential foreground opens, so each new tab
  // inserts after the previous (now-active) one.
  function openAbcAndActivateFirst() {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.openNote('c', 'foreground');
    tabsStore.activateByIndex(0);
  }

  it('nextTab wraps around', () => {
    openAbcAndActivateFirst();
    tabsStore.nextTab();
    expect(tabsStore.activeNoteId).toBe('b');
    tabsStore.nextTab();
    expect(tabsStore.activeNoteId).toBe('c');
    tabsStore.nextTab();
    expect(tabsStore.activeNoteId).toBe('a');
  });

  it('prevTab wraps in reverse', () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.activateByIndex(0);
    tabsStore.prevTab();
    expect(tabsStore.activeNoteId).toBe('b');
  });

  it('activateByIndex clamps', () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.activateByIndex(99);
    expect(tabsStore.activeNoteId).toBe('b');
    tabsStore.activateByIndex(-5);
    expect(tabsStore.activeNoteId).toBe('a');
  });

  it('activateLast picks the rightmost tab', () => {
    openAbcAndActivateFirst();
    tabsStore.activateLast();
    expect(tabsStore.activeNoteId).toBe('c');
  });
});

describe('moveTab', () => {
  function openAbc() {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.openNote('c', 'foreground');
  }

  it('reorders within bounds', () => {
    openAbc();
    tabsStore.moveTab(0, 2);
    expect(tabsStore.tabs.map((t) => t.noteId)).toEqual(['b', 'c', 'a']);
  });

  it('clamps the destination to in-range', () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.moveTab(0, 99);
    expect(tabsStore.tabs.map((t) => t.noteId)).toEqual(['b', 'a']);
  });

  it('ignores from-index out of range', () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('b', 'foreground');
    tabsStore.moveTab(99, 0);
    expect(tabsStore.tabs.map((t) => t.noteId)).toEqual(['a', 'b']);
  });
});

describe('modeFromEvent', () => {
  const setUserAgent = (ua: string) => {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  };

  it('plain click → current', () => {
    expect(
      tabsStore.modeFromEvent({ metaKey: false, ctrlKey: false, shiftKey: false, button: 0 }),
    ).toBe('current');
  });

  it('mac: cmd+click → background', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(
      tabsStore.modeFromEvent({ metaKey: true, ctrlKey: false, shiftKey: false, button: 0 }),
    ).toBe('background');
  });

  it('mac: cmd+shift+click → foreground', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(
      tabsStore.modeFromEvent({ metaKey: true, ctrlKey: false, shiftKey: true, button: 0 }),
    ).toBe('foreground');
  });

  it('non-mac: ctrl+click → background, ctrl+shift+click → foreground', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    expect(
      tabsStore.modeFromEvent({ metaKey: false, ctrlKey: true, shiftKey: false, button: 0 }),
    ).toBe('background');
    expect(
      tabsStore.modeFromEvent({ metaKey: false, ctrlKey: true, shiftKey: true, button: 0 }),
    ).toBe('foreground');
  });

  it('middle-click anywhere → background', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    expect(
      tabsStore.modeFromEvent({ metaKey: false, ctrlKey: false, shiftKey: false, button: 1 }),
    ).toBe('background');
  });

  it('null event → current', () => {
    expect(tabsStore.modeFromEvent(null)).toBe('current');
  });
});

describe('hydrate', () => {
  const validIds = new Set(['a', 'b', 'c']);
  const isValid = (id: string) => validIds.has(id);

  it('replaces pristine state with persisted snapshot', () => {
    const snap: PersistedTabs = {
      tabs: [
        { id: 't1', noteId: 'a' },
        { id: 't2', noteId: 'b' },
      ],
      activeTabId: 't2',
    };
    expect(tabsStore.hydrate(snap, isValid)).toBe(true);
    expect(tabsStore.tabs.map((t) => t.noteId)).toEqual(['a', 'b']);
    expect(tabsStore.activeTabId).toBe('t2');
    expect(tabsStore.hydrated).toBe(true);
  });

  it('drops tabs whose noteId is unknown', () => {
    const snap: PersistedTabs = {
      tabs: [
        { id: 't1', noteId: 'a' },
        { id: 't2', noteId: 'gone' },
      ],
      activeTabId: 't1',
    };
    expect(tabsStore.hydrate(snap, isValid)).toBe(true);
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.tabs[0]!.noteId).toBe('a');
  });

  it("refuses to clobber state if user has already navigated", () => {
    tabsStore.openNote('user-action', 'current');
    const snap: PersistedTabs = {
      tabs: [{ id: 't1', noteId: 'a' }],
      activeTabId: 't1',
    };
    expect(tabsStore.hydrate(snap, isValid)).toBe(false);
    expect(tabsStore.activeNoteId).toBe('user-action');
  });

  it("falls back to first tab if activeTabId is missing in cleaned set", () => {
    const snap: PersistedTabs = {
      tabs: [
        { id: 't1', noteId: 'a' },
        { id: 'gone', noteId: 'gone' },
      ],
      activeTabId: 'gone',
    };
    expect(tabsStore.hydrate(snap, isValid)).toBe(true);
    expect(tabsStore.activeTabId).toBe('t1');
  });

  it("refuses to apply an empty cleaned list (would leave 0 tabs)", () => {
    const snap: PersistedTabs = {
      tabs: [{ id: 't1', noteId: 'gone' }],
      activeTabId: 't1',
    };
    expect(tabsStore.hydrate(snap, isValid)).toBe(false);
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.tabs[0]!.noteId).toBeNull();
  });

  it('only hydrates once', () => {
    tabsStore.markHydrated();
    const snap: PersistedTabs = {
      tabs: [{ id: 't1', noteId: 'a' }],
      activeTabId: 't1',
    };
    expect(tabsStore.hydrate(snap, isValid)).toBe(false);
  });

  describe('initialHashNoteId', () => {
    // Regression: previously the URL hash was applied before hydrate ran,
    // which left the store non-pristine and silently dropped the
    // persisted-tabs snapshot on every deep-linked reload. Now hydrate
    // does both: restore snapshot, then activate or append the hash note.

    it('with snapshot + hash matching a restored tab → restores snapshot and activates that tab', () => {
      const snap: PersistedTabs = {
        tabs: [
          { id: 't1', noteId: 'a' },
          { id: 't2', noteId: 'b' },
          { id: 't3', noteId: 'c' },
        ],
        activeTabId: 't1',
      };
      expect(tabsStore.hydrate(snap, isValid, 'b')).toBe(true);
      expect(tabsStore.tabs.map((t) => t.noteId)).toEqual(['a', 'b', 'c']);
      expect(tabsStore.activeNoteId).toBe('b');
    });

    it('with snapshot + hash for a note not in the snapshot → opens a foreground tab next to active', () => {
      const validWithExtra = new Set([...validIds, 'fresh']);
      const isValidWithExtra = (id: string) => validWithExtra.has(id);
      const snap: PersistedTabs = {
        tabs: [
          { id: 't1', noteId: 'a' },
          { id: 't2', noteId: 'b' },
        ],
        activeTabId: 't1',
      };
      expect(tabsStore.hydrate(snap, isValidWithExtra, 'fresh')).toBe(true);
      // 'fresh' lands immediately after the previously-active tab, per the
      // foreground-open insertion rule. The full snapshot tabs survive.
      expect(tabsStore.tabs.map((t) => t.noteId)).toEqual(['a', 'fresh', 'b']);
      expect(tabsStore.activeNoteId).toBe('fresh');
    });

    it('no snapshot + hash → reuses the lone Home tab', () => {
      expect(tabsStore.hydrate(null, isValid, 'a')).toBe(false);
      expect(tabsStore.tabs).toHaveLength(1);
      expect(tabsStore.activeNoteId).toBe('a');
      expect(tabsStore.hydrated).toBe(true);
    });

    it('null snap + null hash is a clean mark-hydrated', () => {
      expect(tabsStore.hydrate(null, isValid, null)).toBe(false);
      expect(tabsStore.tabs).toHaveLength(1);
      expect(tabsStore.activeNoteId).toBeNull();
      expect(tabsStore.hydrated).toBe(true);
    });
  });
});

describe('persister', () => {
  it("calls the persister on every mutation, excluding 'new' tabs", () => {
    const calls: PersistedTabs[] = [];
    tabsStore.setPersister((s) => calls.push(s));
    tabsStore.openNote('a', 'foreground');
    tabsStore.openNote('new', 'foreground');
    tabsStore.openNote('b', 'background');
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1]!;
    expect(last.tabs.find((t) => t.noteId === 'new')).toBeUndefined();
    expect(last.tabs.map((t) => t.noteId).filter((id) => id !== null)).toContain('a');
    expect(last.tabs.map((t) => t.noteId).filter((id) => id !== null)).toContain('b');
  });
});

describe('replaceTabNoteId and applyRename', () => {
  it("replaceTabNoteId mutates 'new' → real id and clears pendingFolder", () => {
    const t = tabsStore.openNote('new', 'foreground');
    tabsStore.setPendingFolder(t.id, 'Projects');
    expect(t.pendingFolder).toBe('Projects');
    tabsStore.replaceTabNoteId(t.id, 'Projects/real');
    expect(t.noteId).toBe('Projects/real');
    expect(t.pendingFolder).toBeUndefined();
  });

  it('applyRename rewrites every tab pointing at the old id', () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('a', 'background'); // duplicate is fine
    tabsStore.openNote('b', 'background');
    tabsStore.applyRename('a', 'a-renamed');
    const ids = tabsStore.tabs.map((t) => t.noteId);
    expect(ids.filter((id) => id === 'a')).toHaveLength(0);
    expect(ids.filter((id) => id === 'a-renamed')).toHaveLength(2);
    expect(ids).toContain('b');
  });

  it("applyRename also rewrites recentlyClosed entries", () => {
    // Close 'a' so it's in the reopen queue, then a peer rename arrives.
    const t = tabsStore.openNote('a', 'foreground');
    tabsStore.closeTab(t.id);
    expect(tabsStore.recentlyClosed[0]?.noteId).toBe('a');
    tabsStore.applyRename('a', 'a-renamed');
    expect(tabsStore.recentlyClosed[0]?.noteId).toBe('a-renamed');
  });

  it("pruneMissingNoteIds nulls out tabs whose note no longer exists", () => {
    tabsStore.openNote('a', 'current');
    tabsStore.openNote('gone', 'background');
    tabsStore.pruneMissingNoteIds((id) => id === 'a');
    const ids = tabsStore.tabs.map((t) => t.noteId);
    expect(ids).toEqual(['a', null]);
  });

  it("pruneMissingNoteIds also drops dead entries from recentlyClosed", () => {
    const t = tabsStore.openNote('gone', 'foreground');
    tabsStore.closeTab(t.id);
    expect(tabsStore.recentlyClosed[0]?.noteId).toBe('gone');
    tabsStore.pruneMissingNoteIds((id) => id !== 'gone');
    expect(tabsStore.recentlyClosed).toHaveLength(0);
  });
});

describe('setTabState', () => {
  it('stores per-tab editor state but does not persist it', () => {
    const calls: PersistedTabs[] = [];
    tabsStore.setPersister((s) => calls.push(s));
    const t = tabsStore.openNote('a', 'foreground');
    const callsBefore = calls.length;
    tabsStore.setTabState(t.id, { scroll: 120, selFrom: 5, selTo: 5 });
    expect(t.state).toEqual({ scroll: 120, selFrom: 5, selTo: 5 });
    // setTabState is intentionally not a persisted mutation
    expect(calls.length).toBe(callsBefore);
  });
});
