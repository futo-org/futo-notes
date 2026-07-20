export type OpenMode = 'current' | 'background' | 'foreground';

// Per-tab scroll position only (tabs.md). Legacy persisted shapes carrying
// selFrom/selTo still validate — the extra fields are simply ignored.
export type TabState = {
  scroll: number;
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
  state?: TabState;
};

function isValidTabState(s: unknown): s is TabState {
  return !!s && typeof (s as TabState).scroll === 'number';
}

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
  const persistable = _tabs.filter((t) => t.noteId !== 'new');
  if (persistable.length === 0) return;
  persister({
    tabs: persistable.map((t) => ({
      id: t.id,
      noteId: t.noteId,
      ...(t.pendingFolder !== undefined ? { pendingFolder: t.pendingFolder } : {}),
      ...(t.state ? { state: t.state } : {}),
    })),
    activeTabId: persistable.find((t) => t.id === _activeTabId)
      ? _activeTabId
      : (persistable[0]?.id ?? null),
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

  hydrate(
    snap: PersistedTabs | null,
    isNoteIdValid: (id: string) => boolean,
    requestedNoteId: string | null | undefined = undefined,
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
          ...(isValidTabState(t.state) ? { state: t.state } : {}),
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

    if (requestedNoteId !== undefined) {
      const existing = _tabs.find((t) => t.noteId === requestedNoteId);
      if (existing) {
        _activeTabId = existing.id;
      } else if (replaced) {
        this.openNote(requestedNoteId, 'foreground');
      } else {
        this.openNote(requestedNoteId, 'current');
      }
    }

    return replaced;
  },

  markHydrated(): void {
    _hydrated = true;
  },

  openNote(noteId: string | null, mode: OpenMode = 'current'): Tab {
    if (noteId === 'new') {
      const existing = _tabs.find((t) => t.noteId === 'new');
      if (existing) {
        if (mode !== 'background') _activeTabId = existing.id;
        persist();
        return existing;
      }
    }

    if (mode === 'current') {
      const tab = findTab(_activeTabId) ?? _tabs[0]!;
      tab.noteId = noteId;
      tab.state = undefined;
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
    persist();
  },

  setPendingFolder(tabId: string, folder: string | null): void {
    const tab = findTab(tabId);
    if (!tab) return;
    if (folder) tab.pendingFolder = folder;
    else tab.pendingFolder = undefined;
    persist();
  },

  modeFromEvent(
    e?: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'button'> | null,
  ): OpenMode {
    if (!e) return 'current';
    const mod = isMacAgent() ? e.metaKey : e.ctrlKey;
    const middle = e.button === 1;
    if (mod && e.shiftKey) return 'foreground';
    if (mod || middle || e.shiftKey) return 'background';
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
