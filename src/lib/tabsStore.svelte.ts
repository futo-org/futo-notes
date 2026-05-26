/**
 * Desktop tabs store. The active tab's noteId is the source of truth
 * for what the shell renders; the URL hash mirrors it. The store is
 * created at module load with a single "Home" tab and stays in that
 * pristine shape until either the user navigates or `hydrate()`
 * replaces it from persisted config.
 *
 * Persistence is opt-in via `setPersister(fn)`; the store stays
 * unit-testable in isolation.
 */

export type OpenMode = 'current' | 'background' | 'foreground';

export type TabState = {
  scroll: number;
  selFrom: number;
  selTo: number;
};

export type Tab = {
  id: string;
  noteId: string | null;
  pendingFolder?: string;
  state?: TabState;
};

export type PersistedTab = {
  id: string;
  noteId: string | null;
  pendingFolder?: string;
};

export type PersistedTabs = {
  tabs: PersistedTab[];
  activeTabId: string | null;
};

type Persister = (snapshot: PersistedTabs) => void;

const MAX_RECENTLY_CLOSED = 10;

function isMacAgent(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function makeHomeTab(): Tab {
  return { id: newId(), noteId: null };
}

const _initialHome = makeHomeTab();
let _tabs = $state<Tab[]>([_initialHome]);
let _activeTabId = $state<string>(_initialHome.id);
let _recentlyClosed = $state<Tab[]>([]);
let _hydrated = $state(false);

let persister: Persister | null = null;

function findTab(id: string): Tab | null {
  return _tabs.find((t) => t.id === id) ?? null;
}

function findIndex(id: string): number {
  return _tabs.findIndex((t) => t.id === id);
}

function persist(): void {
  if (!persister) return;
  // 'new' tabs aren't persistable — their body lives only in the editor.
  const persistable = _tabs.filter((t) => t.noteId !== 'new');
  if (persistable.length === 0) return;
  persister({
    tabs: persistable.map((t) => ({
      id: t.id,
      noteId: t.noteId,
      ...(t.pendingFolder !== undefined ? { pendingFolder: t.pendingFolder } : {}),
    })),
    activeTabId: persistable.find((t) => t.id === _activeTabId) ? _activeTabId : (persistable[0]?.id ?? null),
  });
}

export const tabsStore = {
  get tabs(): readonly Tab[] {
    return _tabs;
  },
  get activeTabId(): string {
    return _activeTabId;
  },
  get activeTab(): Tab {
    return findTab(_activeTabId) ?? _tabs[0]!;
  },
  get activeNoteId(): string | null {
    return this.activeTab.noteId;
  },
  get recentlyClosed(): readonly Tab[] {
    return _recentlyClosed;
  },
  get hydrated(): boolean {
    return _hydrated;
  },
  get isPristineSingleHome(): boolean {
    return _tabs.length === 1 && _tabs[0]!.noteId === null && _recentlyClosed.length === 0;
  },

  setPersister(p: Persister | null): void {
    persister = p;
  },

  /**
   * Boot the store: optionally restore from a persisted snapshot, then
   * apply the initial URL-hash target (a deep-linked or last-active
   * note). Mutating the store synchronously before hydrate would defeat
   * the pristine check below, so App.svelte must defer the hash to here.
   *
   * The snapshot is only restored when the store is still pristine
   * single-Home — a late load can't clobber live navigation. The hash
   * is always applied: it either activates a matching restored tab,
   * appends a new tab on top of the restored set, or replaces the lone
   * Home tab when no snapshot existed. Returns true iff the snapshot
   * was restored. Marks the store hydrated either way.
   */
  hydrate(
    snap: PersistedTabs | null,
    isNoteIdValid: (id: string) => boolean,
    initialHashNoteId: string | null = null,
  ): boolean {
    if (_hydrated) return false;
    _hydrated = true;

    let replaced = false;
    if (snap && Array.isArray(snap.tabs) && snap.tabs.length > 0 && this.isPristineSingleHome) {
      const cleaned = snap.tabs
        .filter(
          (t) =>
            t.noteId === null ||
            (typeof t.noteId === 'string' && t.noteId !== 'new' && isNoteIdValid(t.noteId)),
        )
        .map<Tab>((t) => ({
          id: typeof t.id === 'string' ? t.id : newId(),
          noteId: t.noteId ?? null,
          ...(t.pendingFolder ? { pendingFolder: t.pendingFolder } : {}),
        }));

      if (cleaned.length > 0) {
        _tabs = cleaned;
        const activeStillPresent = snap.activeTabId
          ? cleaned.find((t) => t.id === snap.activeTabId)
          : null;
        _activeTabId = activeStillPresent ? snap.activeTabId! : cleaned[0]!.id;
        replaced = true;
      }
    }

    if (initialHashNoteId !== null) {
      const existing = _tabs.find((t) => t.noteId === initialHashNoteId);
      if (existing) {
        _activeTabId = existing.id;
      } else if (replaced) {
        this.openNote(initialHashNoteId, 'foreground');
      } else {
        this.openNote(initialHashNoteId, 'current');
      }
    }

    return replaced;
  },

  markHydrated(): void {
    _hydrated = true;
  },

  openNote(noteId: string | null, mode: OpenMode = 'current'): Tab {
    // One "new" tab at a time — avoids "Untitled" duplicate-title collisions.
    if (noteId === 'new') {
      const existing = _tabs.find((t) => t.noteId === 'new');
      if (existing) {
        // 'foreground' and 'current' both want the existing 'new' tab in focus.
        // 'background' must leave the caller's active tab alone — middle-click
        // / cmd-click on a "new note" affordance shouldn't steal focus just
        // because a stale 'new' tab exists.
        if (mode !== 'background') _activeTabId = existing.id;
        persist();
        return existing;
      }
    }

    if (mode === 'current') {
      const tab = findTab(_activeTabId) ?? _tabs[0]!;
      tab.noteId = noteId;
      tab.state = undefined;
      // Clear stale pendingFolder — the user picked a different note for this
      // tab, so the previously-armed save target no longer applies.
      tab.pendingFolder = undefined;
      _activeTabId = tab.id;
      persist();
      return tab;
    }

    const tab: Tab = { id: newId(), noteId };
    const activeIdx = findIndex(_activeTabId);
    const insertAt = activeIdx === -1 ? _tabs.length : activeIdx + 1;
    _tabs.splice(insertAt, 0, tab);
    if (mode === 'foreground') _activeTabId = tab.id;
    persist();
    return tab;
  },

  newTab(): Tab {
    const tab: Tab = { id: newId(), noteId: null };
    const activeIdx = findIndex(_activeTabId);
    const insertAt = activeIdx === -1 ? _tabs.length : activeIdx + 1;
    _tabs.splice(insertAt, 0, tab);
    _activeTabId = tab.id;
    persist();
    return tab;
  },

  closeTab(id: string): void {
    const idx = findIndex(id);
    if (idx === -1) return;
    const [closed] = _tabs.splice(idx, 1);
    // 'new' tabs have no persistable body — reopening one would mint a
    // duplicate 'new' tab and break the "one 'new' tab at a time" invariant.
    if (closed && closed.noteId !== null && closed.noteId !== 'new') {
      _recentlyClosed.unshift({ id: closed.id, noteId: closed.noteId });
      if (_recentlyClosed.length > MAX_RECENTLY_CLOSED) {
        _recentlyClosed.length = MAX_RECENTLY_CLOSED;
      }
    }
    if (_tabs.length === 0) {
      const home = makeHomeTab();
      _tabs.push(home);
      _activeTabId = home.id;
    } else if (_activeTabId === id) {
      const next = _tabs[Math.min(idx, _tabs.length - 1)]!;
      _activeTabId = next.id;
    }
    persist();
  },

  closeActive(): void {
    this.closeTab(_activeTabId);
  },

  activateById(id: string): void {
    if (!findTab(id) || id === _activeTabId) return;
    _activeTabId = id;
    persist();
  },

  activateByIndex(i: number): void {
    if (_tabs.length === 0) return;
    const clamped = Math.max(0, Math.min(i, _tabs.length - 1));
    const next = _tabs[clamped]!.id;
    if (next === _activeTabId) return;
    _activeTabId = next;
    persist();
  },

  activateLast(): void {
    if (_tabs.length === 0) return;
    const next = _tabs[_tabs.length - 1]!.id;
    if (next === _activeTabId) return;
    _activeTabId = next;
    persist();
  },

  nextTab(): void {
    if (_tabs.length <= 1) return;
    const idx = findIndex(_activeTabId);
    _activeTabId = _tabs[(idx + 1 + _tabs.length) % _tabs.length]!.id;
    persist();
  },

  prevTab(): void {
    if (_tabs.length <= 1) return;
    const idx = findIndex(_activeTabId);
    _activeTabId = _tabs[(idx - 1 + _tabs.length) % _tabs.length]!.id;
    persist();
  },

  reopenLastClosed(): Tab | null {
    const restored = _recentlyClosed.shift();
    if (!restored) return null;
    const tab: Tab = { id: newId(), noteId: restored.noteId };
    const activeIdx = findIndex(_activeTabId);
    const insertAt = activeIdx === -1 ? _tabs.length : activeIdx + 1;
    _tabs.splice(insertAt, 0, tab);
    _activeTabId = tab.id;
    persist();
    return tab;
  },

  moveTab(fromIdx: number, toIdx: number): void {
    if (fromIdx < 0 || fromIdx >= _tabs.length) return;
    const to = Math.max(0, Math.min(toIdx, _tabs.length - 1));
    if (to === fromIdx) return;
    const [moved] = _tabs.splice(fromIdx, 1);
    _tabs.splice(to, 0, moved!);
    persist();
  },

  replaceTabNoteId(tabId: string, newNoteId: string): void {
    const tab = findTab(tabId);
    if (!tab) return;
    tab.noteId = newNoteId;
    tab.pendingFolder = undefined;
    persist();
  },

  findTabByNoteId(noteId: string): Tab | null {
    return _tabs.find((t) => t.noteId === noteId) ?? null;
  },

  setTabState(tabId: string, state: TabState | undefined): void {
    const tab = findTab(tabId);
    if (!tab) return;
    tab.state = state;
    // intentionally not persisted
  },

  setPendingFolder(tabId: string, folder: string | null): void {
    const tab = findTab(tabId);
    if (!tab) return;
    if (folder) tab.pendingFolder = folder;
    else tab.pendingFolder = undefined;
    persist();
  },

  /**
   * Chrome-style mode resolver:
   *   mod+shift+click             → foreground new tab
   *   mod+click  OR  middle btn   → background new tab
   *   plain click                 → current tab
   */
  modeFromEvent(
    e?: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'button'> | null,
  ): OpenMode {
    if (!e) return 'current';
    const mod = isMacAgent() ? e.metaKey : e.ctrlKey;
    const middle = e.button === 1;
    if (mod && e.shiftKey) return 'foreground';
    if (mod || middle) return 'background';
    return 'current';
  },

  pruneMissingNoteIds(isValid: (noteId: string) => boolean): void {
    let changed = false;
    for (const tab of _tabs) {
      if (tab.noteId !== null && tab.noteId !== 'new' && !isValid(tab.noteId)) {
        tab.noteId = null;
        changed = true;
      }
    }
    // Drop dead entries from the reopen queue too — reopening a deleted
    // note would surface a broken tab with no source on disk.
    const beforeClosed = _recentlyClosed.length;
    _recentlyClosed = _recentlyClosed.filter(
      (t) => t.noteId === null || t.noteId === 'new' || isValid(t.noteId),
    );
    if (_recentlyClosed.length !== beforeClosed) changed = true;
    if (changed) persist();
  },

  applyRename(from: string, to: string): void {
    let changed = false;
    for (const tab of _tabs) {
      if (tab.noteId === from) {
        tab.noteId = to;
        changed = true;
      }
    }
    // Keep the reopen queue consistent with on-disk ids so Cmd+Shift+T
    // restores the renamed note, not a ghost of its old name.
    for (const t of _recentlyClosed) {
      if (t.noteId === from) {
        t.noteId = to;
        changed = true;
      }
    }
    if (changed) persist();
  },

  __resetForTests(): void {
    _tabs = [makeHomeTab()];
    _activeTabId = _tabs[0]!.id;
    _recentlyClosed = [];
    _hydrated = false;
    persister = null;
  },
};
