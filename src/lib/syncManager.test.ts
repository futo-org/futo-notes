import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────
// Capture the AutoSync callbacks that createSyncManager registers in start(),
// so the test can drive onSyncError / onSyncComplete directly without booting
// the real polling lifecycle or the E2EE server.
let capturedCallbacks: import('./autoSyncV2').AutoSyncCallbacks | null = null;
vi.mock('./autoSyncV2', () => ({
  startAutoSyncV2: (cb: import('./autoSyncV2').AutoSyncCallbacks) => {
    capturedCallbacks = cb;
  },
  stopAutoSyncV2: () => {},
  notifySavedV2: () => {},
}));

// start() opens Tauri event listeners when hasFileSystem is true (default in
// the test env). No-op them so the manager never touches the native bridge.
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

// Spy on appState so the test can assert that a completed sync stamps the
// "last synced" timestamp, without driving the real persistence layer (which
// would hit getPlatformFS under vitest's DEV=true hasFileSystem).
vi.mock('./appState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./appState')>();
  return { ...actual, updateAppState: vi.fn(async () => {}) };
});

// Spy on the Rust search-engine bridge so the test can assert that a sync pull
// reindexes peer changes into Tantivy. The whole module is replaced, so every
// export touched by the syncManager module graph (notes.svelte imports the
// query/status/rebuild trio) must be present.
vi.mock('./searchEngine', () => ({
  isEngineAvailable: () => true,
  engineQuery: vi.fn(async () => []),
  engineStatus: vi.fn(async () => null),
  engineRebuild: vi.fn(async () => {}),
  engineNotify: vi.fn(async () => {}),
}));

import { findActiveSyncRename, createSyncManager, getSyncErrorMessage } from './syncManager.svelte';
import { engineNotify } from './searchEngine';
import { updateAppState } from './appState';
import type { SyncManagerDeps } from './syncManager.svelte';
import type { SyncSummary } from './syncServiceE2ee';

describe('findActiveSyncRename', () => {
  it('prefers an explicit rename from the sync summary', () => {
    expect(findActiveSyncRename({
      updatedIds: [],
      deletedIds: [],
      renamed: [{ fromId: 'Old Title', toId: 'New Title' }],
    }, 'Old Title')).toEqual({ fromId: 'Old Title', toId: 'New Title' });
  });

  it('falls back to a recent recorded rename target', () => {
    expect(findActiveSyncRename({
      updatedIds: [],
      deletedIds: ['Old Title'],
      renamed: [],
    }, 'Old Title', 'Recovered Title')).toEqual({ fromId: 'Old Title', toId: 'Recovered Title' });
  });

  it('infers a rename from delete plus collision-suffixed update', () => {
    expect(findActiveSyncRename({
      updatedIds: ['Old Title (2)'],
      deletedIds: ['Old Title'],
      renamed: [],
    }, 'Old Title')).toEqual({ fromId: 'Old Title', toId: 'Old Title (2)' });
  });

  it('returns null when sync only deleted the note with no recovery target', () => {
    expect(findActiveSyncRename({
      updatedIds: [],
      deletedIds: ['Old Title'],
      renamed: [],
    }, 'Old Title')).toBeNull();
  });
});

// ── F15 regression: auto/background sync errors surface in the UI ──────────
// Previously onSyncError only console.warn'd, and the syncError/syncErrorMessage
// state was deleted — so the status-bar indicator + Settings never showed a
// background sync failure. These pin the error to reactive manager state.

describe('getSyncErrorMessage', () => {
  it('rewrites opaque fetch TypeErrors to an actionable message', () => {
    const err = new TypeError('Failed to fetch');
    expect(getSyncErrorMessage(err)).toBe(
      "Could not reach server — check the URL and make sure it's running",
    );
  });

  it('matches the other fetch-failure phrasings case-insensitively', () => {
    expect(getSyncErrorMessage(new TypeError('Load failed'))).toMatch(/Could not reach server/);
    expect(getSyncErrorMessage(new TypeError('NetworkError when attempting to fetch'))).toMatch(
      /Could not reach server/,
    );
  });

  it('passes through a real Error message verbatim', () => {
    expect(getSyncErrorMessage(new Error('401 Unauthorized'))).toBe('401 Unauthorized');
  });

  it('stringifies non-Error throwables', () => {
    expect(getSyncErrorMessage('plain string failure')).toBe('plain string failure');
  });
});

describe('createSyncManager sync-error state (F15)', () => {
  const emptySummary: SyncSummary = {
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    updatedIds: [],
    deletedIds: [],
    renamed: [],
    peerUpdatedIds: [],
    peerDeletedIds: [],
  };

  function makeDeps(): SyncManagerDeps {
    return {
      getOriginalId: () => null,
      getEditVersion: () => 0,
      isSavePending: () => false,
      hasOpenDraftChanges: () => false,
      getLastEditTime: () => 0,
      applyExternalContent: () => {},
      applyRemoteRename: () => {},
      cancelAndClear: () => {},
      flushSave: async () => {},
      getEditorContent: () => undefined,
      isComposing: () => false,
      patchGraphNode: () => {},
      clearGraphData: () => {},
      showToast: () => {},
      navigate: () => {},
      getNoteId: () => null,
      getPrevNoteId: () => null,
      setPrevNoteId: () => {},
    };
  }

  beforeEach(() => {
    capturedCallbacks = null;
  });

  it('starts with no error', () => {
    const mgr = createSyncManager(makeDeps());
    expect(mgr.syncError).toBe(false);
    expect(mgr.syncErrorMessage).toBe('');
  });

  it('sets reactive error state when a background sync fails', () => {
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();
    expect(capturedCallbacks).not.toBeNull();

    capturedCallbacks!.onSyncError(new TypeError('Failed to fetch'));

    expect(mgr.syncError).toBe(true);
    expect(mgr.syncErrorMessage).toBe(
      "Could not reach server — check the URL and make sure it's running",
    );
    cleanup();
  });

  it('clears the error on the next successful sync', async () => {
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();

    capturedCallbacks!.onSyncError(new Error('boom'));
    expect(mgr.syncError).toBe(true);

    await capturedCallbacks!.onSyncComplete(emptySummary);

    expect(mgr.syncError).toBe(false);
    expect(mgr.syncErrorMessage).toBe('');
    cleanup();
  });

  // Regression: Settings showed a frozen "Last sync: 1mo ago" even after a
  // successful manual "Sync now". Nothing ever wrote a fresh timestamp to
  // appState.lastSyncedAt — it was declared, loaded, and read by Settings, but
  // never stamped on sync success. handleSyncComplete is the single hook for
  // every successful sync (auto, manual, live SSE), so it must record it.
  it('stamps lastSyncedAt on a successful sync', async () => {
    vi.mocked(updateAppState).mockClear();
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();

    const before = Date.now();
    await capturedCallbacks!.onSyncComplete(emptySummary);

    expect(updateAppState).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncedAt: expect.any(Number) }),
    );
    const calls = vi.mocked(updateAppState).mock.calls;
    const stamped = calls[calls.length - 1][0].lastSyncedAt as number;
    expect(stamped).toBeGreaterThanOrEqual(before);
    cleanup();
  });
});

// Regression (work-item #7): notes arriving via an E2EE sync pull landed in
// notesCache + MiniSearch but never in the Rust Tantivy engine, so they were
// unsearchable until an app restart (sync writes are Rust-side and their
// watcher echo is suppressed, so the watcher's engineNotify never fired). The
// post-sync reconcile only touched MiniSearch. handleSyncComplete must now
// reindex peer changes into the engine — mirroring the native rescan-on-pull.
describe('handleSyncComplete reindexes peer changes into the search engine', () => {
  const baseSummary: SyncSummary = {
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    updatedIds: [],
    deletedIds: [],
    renamed: [],
    peerUpdatedIds: [],
    peerDeletedIds: [],
  };

  function makeDeps(): SyncManagerDeps {
    return {
      getOriginalId: () => null,
      getEditVersion: () => 0,
      isSavePending: () => false,
      hasOpenDraftChanges: () => false,
      getLastEditTime: () => 0,
      applyExternalContent: () => {},
      applyRemoteRename: () => {},
      cancelAndClear: () => {},
      flushSave: async () => {},
      getEditorContent: () => undefined,
      isComposing: () => false,
      patchGraphNode: () => {},
      clearGraphData: () => {},
      showToast: () => {},
      navigate: () => {},
      getNoteId: () => null,
      getPrevNoteId: () => null,
      setPrevNoteId: () => {},
    } as unknown as SyncManagerDeps;
  }

  beforeEach(() => {
    capturedCallbacks = null;
    vi.mocked(engineNotify).mockClear();
    // Fake timers so the 50ms post-sync MiniSearch rescan never fires and
    // touches the platform filesystem; engineNotify runs synchronously, before
    // any await, so it lands without advancing timers.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies the engine of peer updates, deletes, and renames', async () => {
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();

    await capturedCallbacks!.onSyncComplete({
      ...baseSummary,
      downloaded: 1,
      deleted: 1,
      updatedIds: ['Peer Note'],
      deletedIds: ['Gone Note'],
      peerUpdatedIds: ['Peer Note'],
      peerDeletedIds: ['Gone Note'],
      renamed: [{ fromId: 'Old Name', toId: 'New Name' }],
    });

    expect(engineNotify).toHaveBeenCalledWith('change', 'Peer Note.md');
    expect(engineNotify).toHaveBeenCalledWith('unlink', 'Gone Note.md');
    expect(engineNotify).toHaveBeenCalledWith('rename', 'New Name.md', 'Old Name.md');
    cleanup();
  });

  it('does not notify the engine for our own pushes (non-peer ids)', async () => {
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();

    // A pure push: our edits echo back in updatedIds/deletedIds but the peer
    // lists are empty. Those ids are already in the engine via the local-edit
    // chokepoint, so re-notifying them would be wasted work.
    await capturedCallbacks!.onSyncComplete({
      ...baseSummary,
      uploaded: 1,
      updatedIds: ['My Edit'],
      deletedIds: ['My Delete'],
    });

    expect(engineNotify).not.toHaveBeenCalled();
    cleanup();
  });
});
