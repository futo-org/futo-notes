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
vi.mock('$features/search/searchEngine', () => ({
  isEngineAvailable: () => true,
  engineQuery: vi.fn(async () => []),
  engineStatus: vi.fn(async () => null),
  engineRebuild: vi.fn(async () => {}),
  engineNotify: vi.fn(async () => {}),
}));

import {
  findActiveSyncRename,
  createSyncManager,
  getSyncErrorMessage,
} from './syncManager.svelte';
import { engineNotify } from '$features/search/searchEngine';
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
    failures: [],
    failureMessage: null,
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

    await capturedCallbacks!.onSyncComplete(emptySummary, 'poll');

    expect(mgr.syncError).toBe(false);
    expect(mgr.syncErrorMessage).toBe('');
    cleanup();
  });

  // Work-item #10: a cycle that COMPLETES but has per-item failures
  // (uploads/deletes that didn't reach the server) must surface — previously
  // these returned Ok and were swallowed to stderr with no user signal.
  // `failureMessage` arrives precomputed from the Rust core.
  const failing: SyncSummary = {
    ...emptySummary,
    uploaded: 2, // partial: some items succeeded while one failed.
    failures: [{ filename: 'note.md', kind: 'upload', statusCode: 500 }],
    failureMessage: "1 change couldn't reach the server (HTTP 500)",
  };

  it('raises the failure indicator + toast when a completed cycle has per-item failures', async () => {
    const toasts: string[] = [];
    const deps = makeDeps();
    deps.showToast = (m) => toasts.push(m);
    const mgr = createSyncManager(deps);
    const cleanup = mgr.start();

    await capturedCallbacks!.onSyncComplete(failing, 'poll');

    expect(mgr.syncError).toBe(true);
    expect(mgr.syncErrorMessage).toBe("1 change couldn't reach the server (HTTP 500)");
    expect(toasts).toEqual(["Sync error: 1 change couldn't reach the server (HTTP 500)"]);
    cleanup();
  });

  it('toasts once on the healthy→failing edge, not on every failing cycle', async () => {
    const toasts: string[] = [];
    const deps = makeDeps();
    deps.showToast = (m) => toasts.push(m);
    const mgr = createSyncManager(deps);
    const cleanup = mgr.start();

    await capturedCallbacks!.onSyncComplete(failing, 'poll');
    await capturedCallbacks!.onSyncComplete(failing, 'poll');
    await capturedCallbacks!.onSyncComplete(failing, 'poll');

    expect(toasts).toHaveLength(1);
    expect(mgr.syncError).toBe(true);
    cleanup();
  });

  it('clears on a clean sync and re-toasts if failures return', async () => {
    const toasts: string[] = [];
    const deps = makeDeps();
    deps.showToast = (m) => toasts.push(m);
    const mgr = createSyncManager(deps);
    const cleanup = mgr.start();

    await capturedCallbacks!.onSyncComplete(failing, 'poll'); // edge → toast #1
    await capturedCallbacks!.onSyncComplete(emptySummary, 'poll'); // clean → clears
    expect(mgr.syncError).toBe(false);
    await capturedCallbacks!.onSyncComplete(failing, 'poll'); // edge again → toast #2

    expect(toasts).toHaveLength(2);
    expect(mgr.syncError).toBe(true);
    cleanup();
  });

  it('clearSyncError() dismisses the indicator on demand (click-to-clear)', async () => {
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();

    await capturedCallbacks!.onSyncComplete(failing, 'poll');
    expect(mgr.syncError).toBe(true);

    mgr.clearSyncError();

    expect(mgr.syncError).toBe(false);
    expect(mgr.syncErrorMessage).toBe('');
    cleanup();
  });

  // The Rust live loop's whole-cycle/stream errors arrive via `sync:live-state`
  // (status "reconnecting", message set). These were dropped — a failing live
  // loop stayed quiet until the (up to 120 s) safety poll hit the same error.
  it('surfaces live-loop errors from sync:live-state (message present)', () => {
    const toasts: string[] = [];
    const deps = makeDeps();
    deps.showToast = (m) => toasts.push(m);
    const mgr = createSyncManager(deps);

    mgr.handleLiveState({ live: false, status: 'reconnecting', message: 'connect: HTTP 500' });

    expect(mgr.syncError).toBe(true);
    expect(mgr.syncErrorMessage).toBe('connect: HTTP 500');
    expect(mgr.live).toBe(false);
    expect(toasts).toEqual(['Sync error: connect: HTTP 500']);
  });

  it('a clean reconnect clears a stream error (the stream recovered)', () => {
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();

    mgr.handleLiveState({ live: true, status: 'connected' });
    expect(mgr.live).toBe(true);
    expect(mgr.syncError).toBe(false);

    mgr.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    expect(mgr.syncError).toBe(true);

    mgr.handleLiveState({ live: true, status: 'connected' });
    expect(mgr.syncError).toBe(false);
    expect(mgr.syncErrorMessage).toBe('');
    cleanup();
  });

  // Regression: a clean background poll used to clear the stream error's
  // dedup message, so a persistently failing stream (API fine, SSE blocked)
  // re-toasted the identical error every reconnect attempt (~15-30s) forever.
  // A clean poll proves syncing works, not that the stream recovered — it
  // must leave the stream error (and its toast dedup) alone.
  it('a clean poll does not clear a stream error or re-arm its toast', async () => {
    const toasts: string[] = [];
    const deps = makeDeps();
    deps.showToast = (m) => toasts.push(m);
    const mgr = createSyncManager(deps);
    const cleanup = mgr.start();

    mgr.handleLiveState({ live: false, status: 'reconnecting', message: 'connect: HTTP 502' });
    await capturedCallbacks!.onSyncComplete(emptySummary, 'poll'); // clean poll
    mgr.handleLiveState({ live: false, status: 'reconnecting', message: 'connect: HTTP 502' });

    expect(mgr.syncError).toBe(true); // stream is still down
    expect(toasts).toEqual(['Sync error: connect: HTTP 502']); // toasted once
    cleanup();
  });

  it('clearSyncError() (click-to-dismiss) clears a stream error too', () => {
    const mgr = createSyncManager(makeDeps());
    const cleanup = mgr.start();

    mgr.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    expect(mgr.syncError).toBe(true);

    mgr.clearSyncError();
    expect(mgr.syncError).toBe(false);
    cleanup();
  });

  // Regression: a live cycle error used to emit `live: false` even though the
  // SSE stream stayed connected — and since only a true stream reconnect
  // restores `live`, the idle ✓ tick vanished until the next stream drop. The
  // Rust loop now reports cycle errors as status "cycle-error" with
  // `live: true`; the error surfaces but the tick survives, and the next
  // clean sync clears it.
  it('a live cycle-error raises the error but keeps live (idle tick) up', async () => {
    const toasts: string[] = [];
    const deps = makeDeps();
    deps.showToast = (m) => toasts.push(m);
    const mgr = createSyncManager(deps);
    const cleanup = mgr.start();

    mgr.handleLiveState({ live: true, status: 'connected' });
    mgr.handleLiveState({ live: true, status: 'cycle-error', message: 'HTTP 500' });

    expect(mgr.live).toBe(true);
    expect(mgr.syncError).toBe(true);
    expect(toasts).toEqual(['Sync error: HTTP 500']);

    // Same failure class as a poll error — a clean completed sync clears it.
    await capturedCallbacks!.onSyncComplete(emptySummary, 'poll');
    expect(mgr.syncError).toBe(false);
    cleanup();
  });

  it('re-toasts when a subsequent error has a different message (no clear needed)', async () => {
    const toasts: string[] = [];
    const deps = makeDeps();
    deps.showToast = (m) => toasts.push(m);
    const mgr = createSyncManager(deps);
    const cleanup = mgr.start();

    const fail = (statusCode: number): SyncSummary => ({
      ...emptySummary,
      failures: [{ filename: 'a.md', kind: 'upload', statusCode }],
      failureMessage: `1 change couldn't reach the server (HTTP ${statusCode})`,
    });

    await capturedCallbacks!.onSyncComplete(fail(500), 'poll'); // first → toast
    await capturedCallbacks!.onSyncComplete(fail(500), 'poll'); // identical message → silent
    await capturedCallbacks!.onSyncComplete(fail(403), 'poll'); // different message → re-toast (no clear between)

    expect(toasts).toEqual([
      "Sync error: 1 change couldn't reach the server (HTTP 500)",
      "Sync error: 1 change couldn't reach the server (HTTP 403)",
    ]);
    expect(mgr.syncError).toBe(true);
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
    await capturedCallbacks!.onSyncComplete(emptySummary, 'poll');

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

// Regression: the Settings connect flow toasted "Sync complete" (and Sync now
// set the same status line) whenever requestSyncV2 RESOLVED — but a cycle that
// completes with per-item failures resolves normally, so connecting to a
// server whose uploads 500 reported "Sync complete" while nothing reached it.
// Completion feedback is now decided in ONE place — handleSyncComplete — keyed
// on the trigger: manual clean cycles toast "Sync complete", background stays
// quiet, and a failing cycle never reports success regardless of trigger.
describe('single-reporter completion feedback (handleSyncComplete + trigger)', () => {
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

  function makeDeps(toasts: string[]): SyncManagerDeps {
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
      showToast: (m) => toasts.push(m),
      navigate: () => {},
      getNoteId: () => null,
      getPrevNoteId: () => null,
      setPrevNoteId: () => {},
    };
  }

  it("toasts 'Sync complete' for a clean MANUAL sync", async () => {
    const toasts: string[] = [];
    const mgr = createSyncManager(makeDeps(toasts));
    await mgr.handleSyncComplete(emptySummary, 'manual');
    expect(toasts).toEqual(['Sync complete']);
  });

  it('stays quiet for clean background/live syncs', async () => {
    const toasts: string[] = [];
    const mgr = createSyncManager(makeDeps(toasts));
    await mgr.handleSyncComplete(emptySummary, 'poll');
    await mgr.handleSyncComplete(emptySummary); // live-SSE path passes no trigger
    expect(toasts).toEqual([]);
  });

  it("never reports 'Sync complete' for a manual cycle with per-item failures", async () => {
    const toasts: string[] = [];
    const mgr = createSyncManager(makeDeps(toasts));
    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        failures: [{ filename: 'a.md', kind: 'upload', statusCode: 500 }],
        failureMessage: "1 change couldn't reach the server (HTTP 500)",
      },
      'manual',
    );
    expect(toasts).toEqual(["Sync error: 1 change couldn't reach the server (HTTP 500)"]);
    expect(mgr.syncError).toBe(true);
  });
});
