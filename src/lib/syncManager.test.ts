// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let autoSyncCallbacks: import('./autoSyncV2').AutoSyncCallbacks | null = null;
vi.mock('./autoSyncV2', () => ({
  startAutoSyncV2: (callbacks: import('./autoSyncV2').AutoSyncCallbacks) => {
    autoSyncCallbacks = callbacks;
  },
  stopAutoSyncV2: vi.fn(),
  notifySavedV2: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('$lib/platform', () => ({ hasFileSystem: true, isTauri: false }));
vi.mock('./appState', () => ({ updateAppState: vi.fn(async () => {}) }));
const rescanLocalNotes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./localNoteStore', () => ({
  getLocalNoteStore: vi.fn(async () => ({ rescan: rescanLocalNotes })),
}));
vi.mock('./notes.svelte', () => ({
  readNote: vi.fn(async () => ''),
  noteExists: vi.fn(async () => false),
  getNoteById: vi.fn(() => undefined),
  handleExternalFileChange: vi.fn(async () => {}),
  refreshNotesFromStorage: vi.fn(async () => {}),
}));

import { updateAppState } from './appState';
import { noteExists, readNote, refreshNotesFromStorage } from './notes.svelte';
import type { NoteSession } from './noteSession.svelte';
import {
  createSyncManager,
  findActiveSyncRename,
  getSyncErrorMessage,
  type SyncManagerDeps,
} from './syncManager.svelte';
import type { SyncSummary } from './syncServiceE2ee';

const emptySummary: SyncSummary = {
  uploaded: 0,
  downloaded: 0,
  deleted: 0,
  conflicts: 0,
  failures: [],
  failureMessage: null,
  updatedIds: [],
  deletedIds: [],
  renamed: [],
  peerUpdatedIds: [],
  peerDeletedIds: [],
};

type SessionState = {
  id: string | null;
  content: string | undefined;
  dirty: boolean;
  focused: boolean;
  composing: boolean;
  savePending: boolean;
  editVersion: number;
  lastEditTime: number;
};

function makeSession(overrides: Partial<SessionState> = {}) {
  const state: SessionState = {
    id: null,
    content: undefined,
    dirty: false,
    focused: false,
    composing: false,
    savePending: false,
    editVersion: 0,
    lastEditTime: 0,
    ...overrides,
  };
  const applyExternalContent = vi.fn((content: string) => {
    state.content = content;
  });
  const applyRemoteRename = vi.fn((id: string) => {
    state.id = id;
  });
  const cancelAndClear = vi.fn(() => {
    state.id = null;
  });
  const session = {
    get originalId() {
      return state.id;
    },
    get editorContent() {
      return state.content;
    },
    get dirty() {
      return state.dirty;
    },
    get editorFocused() {
      return state.focused;
    },
    get composing() {
      return state.composing;
    },
    get savePending() {
      return state.savePending;
    },
    get editVersion() {
      return state.editVersion;
    },
    get lastEditTime() {
      return state.lastEditTime;
    },
    flushSave: vi.fn(async () => {}),
    applyExternalContent,
    applyRemoteRename,
    cancelAndClear,
  } as unknown as NoteSession;
  return { state, session, applyExternalContent, applyRemoteRename, cancelAndClear };
}

function makeManager(
  sessionBundle = makeSession(),
  overrides: Partial<Omit<SyncManagerDeps, 'session'>> = {},
) {
  const toasts: string[] = [];
  const onRename = vi.fn();
  const pruneTabsForDeletedIds = vi.fn();
  const manager = createSyncManager({
    session: sessionBundle.session,
    showToast: (message) => toasts.push(message),
    onRename,
    pruneTabsForDeletedIds,
    ...overrides,
  });
  return { manager, toasts, onRename, pruneTabsForDeletedIds, ...sessionBundle };
}

beforeEach(() => {
  autoSyncCallbacks = null;
  vi.mocked(readNote).mockReset();
  vi.mocked(readNote).mockResolvedValue('FRESH');
  vi.mocked(noteExists).mockReset();
  vi.mocked(noteExists).mockResolvedValue(false);
  vi.mocked(refreshNotesFromStorage).mockClear();
  rescanLocalNotes.mockClear();
  vi.mocked(updateAppState).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rename classification', () => {
  it('prefers an explicit rename from the sync summary', () => {
    expect(
      findActiveSyncRename(
        { updatedIds: [], deletedIds: [], renamed: [{ fromId: 'Old', toId: 'New' }] },
        'Old',
      ),
    ).toEqual({ fromId: 'Old', toId: 'New' });
  });

  it('falls back to a recent recorded rename target', () => {
    expect(
      findActiveSyncRename(
        { updatedIds: [], deletedIds: ['Old'], renamed: [] },
        'Old',
        'Recovered',
      ),
    ).toEqual({ fromId: 'Old', toId: 'Recovered' });
  });

  it('infers a rename from delete plus collision-suffixed update', () => {
    expect(
      findActiveSyncRename({ updatedIds: ['Old (2)'], deletedIds: ['Old'], renamed: [] }, 'Old'),
    ).toEqual({ fromId: 'Old', toId: 'Old (2)' });
  });

  it('returns null when sync only deleted the note with no recovery target', () => {
    expect(
      findActiveSyncRename({ updatedIds: [], deletedIds: ['Old'], renamed: [] }, 'Old'),
    ).toBeNull();
  });
});

describe('sync outcome state', () => {
  it('rewrites opaque fetch TypeErrors to an actionable message', () => {
    expect(getSyncErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Could not reach server/);
  });

  it('surfaces a background error and clears it on the next clean cycle', async () => {
    const { manager } = makeManager();
    const cleanup = manager.start();
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'));
    expect(manager.syncErrorMessage).toMatch(/Could not reach server/);

    await autoSyncCallbacks!.onSyncComplete(emptySummary, 'poll');
    expect(manager.syncError).toBe(false);
    cleanup();
  });

  it('toasts once per distinct failure message and re-arms after a clean cycle', async () => {
    const { manager, toasts } = makeManager();
    const failure = (code: number): SyncSummary => ({
      ...emptySummary,
      failures: [{ filename: 'note.md', kind: 'upload', statusCode: code }],
      failureMessage: `1 change couldn't reach the server (HTTP ${code})`,
    });

    await manager.handleSyncComplete(failure(500), 'poll');
    await manager.handleSyncComplete(failure(500), 'poll');
    await manager.handleSyncComplete(failure(403), 'poll');
    await manager.handleSyncComplete(emptySummary, 'poll');
    await manager.handleSyncComplete(failure(500), 'poll');

    expect(toasts).toEqual([
      "Sync error: 1 change couldn't reach the server (HTTP 500)",
      "Sync error: 1 change couldn't reach the server (HTTP 403)",
      "Sync error: 1 change couldn't reach the server (HTTP 500)",
    ]);
  });

  it('a clean poll cannot clear or re-toast a still-broken stream', async () => {
    const { manager, toasts } = makeManager();
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    await manager.handleSyncComplete(emptySummary, 'poll');
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    expect(manager.syncError).toBe(true);
    expect(toasts).toEqual(['Sync error: stream lost']);
  });

  it('a stream reconnect clears stream errors while a cycle error keeps live true', () => {
    const { manager } = makeManager();
    manager.handleLiveState({ live: true, status: 'cycle-error', message: 'HTTP 500' });
    expect(manager.live).toBe(true);
    expect(manager.syncError).toBe(true);
    manager.handleLiveState({ live: true, status: 'connected' });
    // Connected only clears stream errors; the cycle error remains until a clean cycle.
    expect(manager.syncError).toBe(true);

    manager.clearSyncError();
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    manager.handleLiveState({ live: true, status: 'connected' });
    expect(manager.syncError).toBe(false);
  });

  it('manual clean cycles are the only clean cycles that toast completion', async () => {
    const { manager, toasts } = makeManager();
    await manager.handleSyncComplete(emptySummary, 'poll');
    await manager.handleSyncComplete(emptySummary);
    await manager.handleSyncComplete(emptySummary, 'manual');
    expect(toasts).toEqual(['Sync complete']);
  });

  it('stamps lastSyncedAt for every completed cycle', async () => {
    const { manager } = makeManager();
    await manager.handleSyncComplete(emptySummary, 'poll');
    expect(updateAppState).toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
  });
});

describe('peer projections', () => {
  it('reconciles the owned index once for a peer-driven batch', async () => {
    const { manager } = makeManager();
    await manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Peer', 'Mine'],
      deletedIds: ['Gone'],
      peerUpdatedIds: ['Peer'],
      peerDeletedIds: ['Gone'],
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });
    expect(rescanLocalNotes).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile the owned index for a pure push echo', async () => {
    const { manager } = makeManager();
    await manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Mine'],
    });
    expect(rescanLocalNotes).not.toHaveBeenCalled();
  });

  it('retargets an inferred rename before pruning the deleted id', async () => {
    vi.mocked(noteExists).mockImplementation(async (id) => id === 'Old (2)');
    const bundle = makeManager(makeSession({ id: 'Old', content: 'body' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Old (2)'],
      deletedIds: ['Old'],
      peerUpdatedIds: ['Old (2)'],
      peerDeletedIds: ['Old'],
    });
    expect(bundle.onRename).toHaveBeenCalledWith('Old', 'Old (2)', 'Old (2)');
    expect(bundle.applyRemoteRename).toHaveBeenCalledWith('Old (2)', 'Old (2)');
    if (bundle.pruneTabsForDeletedIds.mock.calls.length > 0) {
      expect(bundle.onRename.mock.invocationCallOrder[0]).toBeLessThan(
        bundle.pruneTabsForDeletedIds.mock.invocationCallOrder[0],
      );
    }
  });
});

describe('focused-editor reconciliation', () => {
  it('defers a watcher adopt until the focused editor blurs', async () => {
    const bundle = makeManager(makeSession({ id: 'WatcherFocus', content: 'OLD', focused: true }));
    await bundle.manager.handleFileChange({ type: 'change', filename: 'WatcherFocus.md' });
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    bundle.state.focused = false;
    await bundle.manager.handleEditorFocusChange(false);
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });

  it('adopts watcher and sync content immediately when the editor is not focused', async () => {
    const watcher = makeManager(makeSession({ id: 'WatcherBlur', content: 'OLD' }));
    await watcher.manager.handleFileChange({ type: 'change', filename: 'WatcherBlur.md' });
    expect(watcher.applyExternalContent).toHaveBeenCalledWith('FRESH');

    const synced = makeManager(makeSession({ id: 'SyncBlur', content: 'OLD' }));
    await synced.manager.handleSyncComplete({ ...emptySummary, updatedIds: ['SyncBlur'] });
    expect(synced.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });

  it('keeps a draft created after an adopt was deferred', async () => {
    const bundle = makeManager(makeSession({ id: 'DirtyLater', content: 'OLD', focused: true }));
    await bundle.manager.handleFileChange({ type: 'change', filename: 'DirtyLater.md' });
    bundle.state.focused = false;
    bundle.state.dirty = true;
    bundle.state.content = 'LOCAL';
    await bundle.manager.handleEditorFocusChange(false);
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    expect(bundle.toasts).toContain('Open note changed externally; keeping local draft');
  });
});

describe('peer deletion safety', () => {
  it('closes a clean deleted open note instead of adopting an empty string', async () => {
    vi.mocked(readNote).mockResolvedValue('');
    const bundle = makeManager(makeSession({ id: 'Doomed', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['Doomed'],
      peerDeletedIds: ['Doomed'],
    });
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    expect(bundle.toasts).toContain('Note was deleted during sync');
  });

  it('keeps an unsaved draft and excludes it from tab pruning', async () => {
    const bundle = makeManager(makeSession({ id: 'DirtyDoomed', content: 'LOCAL', dirty: true }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['DirtyDoomed', 'BackgroundGone'],
      peerDeletedIds: ['DirtyDoomed', 'BackgroundGone'],
    });
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['BackgroundGone']);
  });

  it('adopts a deleted-then-recreated note when it still exists on disk', async () => {
    vi.mocked(noteExists).mockResolvedValue(true);
    vi.mocked(readNote).mockResolvedValue('# recreated');
    const bundle = makeManager(makeSession({ id: 'Recreated', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Recreated'],
      deletedIds: ['Recreated'],
      peerUpdatedIds: ['Recreated'],
      peerDeletedIds: ['Recreated'],
    });
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('# recreated');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  it('closes and prunes an id in both lists when the file is gone', async () => {
    const bundle = makeManager(makeSession({ id: 'Contested', content: 'MY PUSH' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      uploaded: 1,
      updatedIds: ['Contested'],
      deletedIds: ['Contested'],
      peerDeletedIds: ['Contested'],
    });
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Contested']);
  });

  it('prunes only deleted background notes that are absent on disk', async () => {
    vi.mocked(noteExists).mockImplementation(async (id) => id === 'Recreated');
    const bundle = makeManager();
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['Gone', 'Recreated'],
      updatedIds: ['Recreated'],
      peerDeletedIds: ['Gone', 'Recreated'],
      peerUpdatedIds: ['Recreated'],
    });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Gone']);
  });

  it('fails closed for the open note but skips pruning when existence probes reject', async () => {
    vi.mocked(noteExists).mockRejectedValue(new Error('vault unavailable'));
    const bundle = makeManager(makeSession({ id: 'ProbeError', content: 'OLD' }));
    await expect(
      bundle.manager.handleSyncComplete({
        ...emptySummary,
        deletedIds: ['ProbeError'],
        peerDeletedIds: ['ProbeError'],
      }),
    ).resolves.toBeUndefined();
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.pruneTabsForDeletedIds).not.toHaveBeenCalled();
  });

  it('re-verifies an empty read so a TOCTOU unlink closes instead of resurrecting', async () => {
    vi.mocked(noteExists).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(readNote).mockResolvedValue('');
    const bundle = makeManager(makeSession({ id: 'Vanisher', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Vanisher'],
      deletedIds: ['Vanisher'],
      peerDeletedIds: ['Vanisher'],
    });
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
  });

  it('still adopts a legitimately empty recreated note', async () => {
    vi.mocked(noteExists).mockResolvedValue(true);
    vi.mocked(readNote).mockResolvedValue('');
    const bundle = makeManager(makeSession({ id: 'EmptyRecreated', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['EmptyRecreated'],
      deletedIds: ['EmptyRecreated'],
      peerDeletedIds: ['EmptyRecreated'],
    });
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  it('still prunes other deleted tabs when the active note switches during a read', async () => {
    const bundle = makeManager(makeSession({ id: 'Active', content: 'OLD' }));
    vi.mocked(noteExists).mockImplementation(async (id) => id !== 'OtherGone');
    vi.mocked(readNote).mockImplementation(async () => {
      bundle.state.id = 'Elsewhere';
      return '# fresh';
    });
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Active'],
      deletedIds: ['Active', 'OtherGone'],
      peerUpdatedIds: ['Active'],
      peerDeletedIds: ['Active', 'OtherGone'],
    });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['OtherGone']);
  });
});
