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

const rescanLocalNotes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/localNoteStore', () => ({
  getLocalNoteStore: vi.fn(async () => ({ rescan: rescanLocalNotes })),
}));

// Stub the filesystem-touching notes helpers the watcher/sync paths call so the
// focus-guard tests can drive the real handlers without hitting platform FS.
vi.mock('./notes.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notes.svelte')>();
  return {
    ...actual,
    readNote: vi.fn(async () => ''),
    // Default: a note this cycle deleted is GONE from disk (the F4 case). Tests
    // that model a recreate override this to true for the recreated id.
    noteExists: vi.fn(async () => false),
    handleExternalFileChange: vi.fn(async () => {}),
    refreshNotesFromStorage: vi.fn(async () => {}),
  };
});

import { findActiveSyncRename, createSyncManager, getSyncErrorMessage } from './syncManager.svelte';
import { readNote, noteExists, refreshNotesFromStorage } from './notes.svelte';
import { updateAppState } from './appState';
import type { SyncManagerDeps } from './syncManager.svelte';
import type { SyncSummary } from './syncServiceE2ee';

describe('findActiveSyncRename', () => {
  it('prefers an explicit rename from the sync summary', () => {
    expect(
      findActiveSyncRename(
        {
          updatedIds: [],
          deletedIds: [],
          renamed: [{ fromId: 'Old Title', toId: 'New Title' }],
        },
        'Old Title',
      ),
    ).toEqual({ fromId: 'Old Title', toId: 'New Title' });
  });

  it('falls back to a recent recorded rename target', () => {
    expect(
      findActiveSyncRename(
        {
          updatedIds: [],
          deletedIds: ['Old Title'],
          renamed: [],
        },
        'Old Title',
        'Recovered Title',
      ),
    ).toEqual({ fromId: 'Old Title', toId: 'Recovered Title' });
  });

  it('infers a rename from delete plus collision-suffixed update', () => {
    expect(
      findActiveSyncRename(
        {
          updatedIds: ['Old Title (2)'],
          deletedIds: ['Old Title'],
          renamed: [],
        },
        'Old Title',
      ),
    ).toEqual({ fromId: 'Old Title', toId: 'Old Title (2)' });
  });

  it('returns null when sync only deleted the note with no recovery target', () => {
    expect(
      findActiveSyncRename(
        {
          updatedIds: [],
          deletedIds: ['Old Title'],
          renamed: [],
        },
        'Old Title',
      ),
    ).toBeNull();
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
      isEditorFocused: () => false,
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

describe('handleSyncComplete reconciles peer changes through the local note store', () => {
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
      isEditorFocused: () => false,
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
    rescanLocalNotes.mockClear();
    // The delayed presentation refresh is separate from the immediate durable
    // store reconcile asserted below.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests one durable rescan for a peer update batch', async () => {
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

    await vi.waitFor(() => expect(rescanLocalNotes).toHaveBeenCalledTimes(1));
    cleanup();
  });

  it('does not rescan for our own pushes (non-peer ids)', async () => {
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

    expect(rescanLocalNotes).not.toHaveBeenCalled();
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
      isEditorFocused: () => false,
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

// Regression (CM position-desync crash, 166/172 crashes): replacing the OPEN
// note's document while its editor is focused leaves CM6's async
// DOM-selection/scroll/measure machinery holding pre-update positions; once the
// adopted doc is shorter, CM6 throws RangeError "Selection points outside of
// document" / "No tile at position N" / "Invalid position N in document". The
// fix: never adopt external content into the open note while the editor is
// focused — from both the file watcher and the post-sync reconcile.
describe('focus guard: no external adopt into a focused editor', () => {
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

  function makeDeps(overrides: Partial<SyncManagerDeps>): SyncManagerDeps {
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
      isEditorFocused: () => false,
      patchGraphNode: () => {},
      clearGraphData: () => {},
      showToast: () => {},
      navigate: () => {},
      getNoteId: () => null,
      getPrevNoteId: () => null,
      setPrevNoteId: () => {},
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(readNote).mockReset();
    vi.mocked(readNote).mockResolvedValue('FRESH EXTERNAL CONTENT');
    vi.mocked(refreshNotesFromStorage).mockClear();
  });

  it('watcher: defers applyExternalContent for the focused open note until blur', async () => {
    const applyExternalContent = vi.fn();
    let focused = true;
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'FocusNote',
        isEditorFocused: () => focused,
        applyExternalContent,
      }),
    );

    await mgr.handleFileChange({ type: 'change', filename: 'FocusNote.md' });

    expect(applyExternalContent).not.toHaveBeenCalled();
    focused = false;
    await mgr.handleEditorFocusChange(false);
    expect(applyExternalContent).toHaveBeenCalledWith('FRESH EXTERNAL CONTENT');
  });

  it('watcher: still adopts the open note when the editor is NOT focused', async () => {
    const applyExternalContent = vi.fn();
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'BlurNote',
        isEditorFocused: () => false,
        applyExternalContent,
      }),
    );

    await mgr.handleFileChange({ type: 'change', filename: 'BlurNote.md' });

    expect(applyExternalContent).toHaveBeenCalledWith('FRESH EXTERNAL CONTENT');
  });

  it('sync-complete: defers applyExternalContent for the focused open note until blur', async () => {
    const applyExternalContent = vi.fn();
    let focused = true;
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'SyncNote',
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => focused,
        applyExternalContent,
      }),
    );

    await mgr.handleSyncComplete({ ...emptySummary, updatedIds: ['SyncNote'] }, 'poll');

    expect(applyExternalContent).not.toHaveBeenCalled();
    focused = false;
    await mgr.handleEditorFocusChange(false);
    expect(applyExternalContent).toHaveBeenCalledWith('FRESH EXTERNAL CONTENT');
  });

  it('sync-complete: still adopts the open note when the editor is NOT focused', async () => {
    const applyExternalContent = vi.fn();
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'SyncNote2',
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        applyExternalContent,
      }),
    );

    await mgr.handleSyncComplete({ ...emptySummary, updatedIds: ['SyncNote2'] }, 'poll');

    expect(applyExternalContent).toHaveBeenCalledWith('FRESH EXTERNAL CONTENT');
  });

  it('converts a deferred focused adopt into local-draft preservation when the user edits before blur', async () => {
    const applyExternalContent = vi.fn();
    const toasts: string[] = [];
    let focused = true;
    let dirty = false;
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'DirtyLater',
        getEditorContent: () => (dirty ? 'LOCAL EDIT' : 'OLD CONTENT'),
        isEditorFocused: () => focused,
        hasOpenDraftChanges: () => dirty,
        applyExternalContent,
        showToast: (msg) => toasts.push(msg),
      }),
    );

    await mgr.handleFileChange({ type: 'change', filename: 'DirtyLater.md' });

    dirty = true;
    focused = false;
    await mgr.handleEditorFocusChange(false);

    expect(applyExternalContent).not.toHaveBeenCalled();
    expect(toasts).toEqual(['Open note changed externally; keeping local draft']);
    expect(refreshNotesFromStorage).toHaveBeenCalledTimes(1);
  });
});

// Regression (F4): a peer that deletes the currently-open note used to blank
// the editor and resurrect the file. read_note returns "" for a missing file
// on Tauri (crud.rs scan-time tolerance, contract §8.3), so the post-sync adopt
// path read "" and called applyExternalContent("") — leaving the session bound
// to the deleted id, so the next keystroke re-created the file and undid the
// peer's delete fleet-wide. handleSyncComplete must instead branch on
// summary.deletedIds and close the open session (never adopt ""), mirroring the
// local-watcher unlink-of-open-note path.
describe('F4: peer-delete of the open note closes the session, never adopts ""', () => {
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

  function makeDeps(overrides: Partial<SyncManagerDeps>): SyncManagerDeps {
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
      isEditorFocused: () => false,
      patchGraphNode: () => {},
      clearGraphData: () => {},
      showToast: () => {},
      navigate: () => {},
      getNoteId: () => null,
      getPrevNoteId: () => null,
      setPrevNoteId: () => {},
      ...overrides,
    };
  }

  beforeEach(() => {
    // Tauri production semantics: read_note returns "" for a missing file.
    vi.mocked(readNote).mockReset();
    vi.mocked(readNote).mockResolvedValue('');
    // Default: a deleted note is gone from disk (F4). Recreate tests override.
    vi.mocked(noteExists).mockReset();
    vi.mocked(noteExists).mockResolvedValue(false);
    vi.mocked(refreshNotesFromStorage).mockClear();
  });

  it('closes the open session and toasts instead of blanking the editor', async () => {
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    const toasts: string[] = [];
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'Doomed',
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
        showToast: (m) => toasts.push(m),
      }),
    );

    await mgr.handleSyncComplete(
      { ...emptySummary, deleted: 1, deletedIds: ['Doomed'], peerDeletedIds: ['Doomed'] },
      'poll',
    );

    expect(applyExternalContent).not.toHaveBeenCalled();
    expect(cancelAndClear).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual(['Note was deleted during sync']);
  });

  it('keeps an unsaved local draft (never closes) when the deleted open note has draft changes', async () => {
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    const toasts: string[] = [];
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'DirtyDoomed',
        getEditorContent: () => 'LOCAL EDIT',
        hasOpenDraftChanges: () => true,
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
        showToast: (m) => toasts.push(m),
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        deleted: 1,
        deletedIds: ['DirtyDoomed'],
        peerDeletedIds: ['DirtyDoomed'],
      },
      'poll',
    );

    expect(cancelAndClear).not.toHaveBeenCalled();
    expect(applyExternalContent).not.toHaveBeenCalled();
    expect(toasts).toEqual(['Open note was deleted during sync; keeping local draft']);
    expect(refreshNotesFromStorage).toHaveBeenCalledTimes(1);
  });

  it('still follows a collision-rename of the open note rather than closing it', async () => {
    // fromId shows up in deletedIds but a collision-suffixed variant is in
    // updatedIds — that is a rename, resolved by the activeRename block before
    // the delete branch, so the session must NOT be closed.
    // applyActiveRename reads window.location.hash (node env has no window).
    vi.stubGlobal('window', { location: { hash: '' } });
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    // The real noteSession moves originalId to the new id when a remote rename
    // is applied; model that so the re-read after the rename sees 'Renamed (2)'.
    let currentId = 'Renamed';
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => currentId,
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
        applyRemoteRename: (newId: string) => {
          currentId = newId;
        },
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        updatedIds: ['Renamed (2)'],
        deletedIds: ['Renamed'],
        renamed: [{ fromId: 'Renamed', toId: 'Renamed (2)' }],
        peerUpdatedIds: ['Renamed (2)'],
        peerDeletedIds: ['Renamed'],
      },
      'poll',
    );

    expect(cancelAndClear).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // Regression (remote-rename.spec.ts "delete plus collision-suffixed update"):
  // a COLLISION-INFERRED rename (old id in deletedIds + a suffixed successor in
  // updatedIds, with renamed:[] so the explicit-rename loop never fired) must
  // retarget the tabs store too. Otherwise the tab keeps pointing at the old id
  // and the W2 tab-prune nulls it, sending the just-followed editor to Home.
  it('retargets tabs (onAnySyncRename) for a collision-inferred rename and does not prune the old id', async () => {
    vi.stubGlobal('window', { location: { hash: '' } });
    vi.mocked(noteExists).mockImplementation(async (id: string) => id === 'Old Title (2)');
    vi.mocked(readNote).mockResolvedValue('Body content');
    const onAnySyncRename = vi.fn();
    const pruneTabsForDeletedIds = vi.fn();
    const cancelAndClear = vi.fn();
    let currentId = 'Old Title';
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => currentId,
        getEditorContent: () => 'Body content',
        isEditorFocused: () => false,
        cancelAndClear,
        applyRemoteRename: (newId: string) => {
          currentId = newId;
        },
        onAnySyncRename,
        pruneTabsForDeletedIds,
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        updatedIds: ['Old Title (2)'],
        deletedIds: ['Old Title'],
        renamed: [], // collision-inferred, NOT an explicit rename
        peerUpdatedIds: ['Old Title (2)'],
        peerDeletedIds: ['Old Title'],
      },
      'poll',
    );

    expect(onAnySyncRename).toHaveBeenCalledWith('Old Title', 'Old Title (2)');
    expect(cancelAndClear).not.toHaveBeenCalled();
    // The retarget must run BEFORE the tab-prune. The prune still lists the old
    // id (it is gone from disk), but by then the tab points at the successor, so
    // pruneMissingNoteIds is a no-op on it (verified end-to-end by the Playwright
    // remote-rename spec). Ordering is what the seam can prove.
    if (pruneTabsForDeletedIds.mock.calls.length > 0) {
      expect(onAnySyncRename.mock.invocationCallOrder[0]).toBeLessThan(
        pruneTabsForDeletedIds.mock.invocationCallOrder[0],
      );
    }
    vi.unstubAllGlobals();
  });

  // W1: a peer can delete note X and recreate the same filename before this
  // client pulls, so the combined push+pull summary can carry X in BOTH
  // deletedIds and updatedIds. Existence — not updatedIds membership — decides:
  // if X is on disk it was recreated → adopt; if gone it was tombstoned → close.
  it('adopts the replacement when the open note was deleted then recreated ON DISK', async () => {
    vi.mocked(readNote).mockResolvedValue('# Recreated content');
    vi.mocked(noteExists).mockResolvedValue(true); // recreated → present on disk
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    const toasts: string[] = [];
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'RecreatedNote',
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
        showToast: (m) => toasts.push(m),
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        updatedIds: ['RecreatedNote'],
        deletedIds: ['RecreatedNote'],
        peerUpdatedIds: ['RecreatedNote'],
        peerDeletedIds: ['RecreatedNote'],
      },
      'poll',
    );

    expect(cancelAndClear).not.toHaveBeenCalled();
    expect(toasts).not.toContain('Note was deleted during sync');
    expect(applyExternalContent).toHaveBeenCalledWith('# Recreated content');
  });

  // W1 P1 (the round-2 Codex finding): updatedIds aggregates push AND pull, so
  // it contains ids WE uploaded. This client pushes an edit to X (X → updatedIds
  // via push) while a peer tombstones X the same cycle; the pull removes X from
  // disk. The old "in both lists ⇒ recreated" rule wrongly adopted "" and left
  // the editor/tab bound → resurrection. Existence is authoritative: file ABSENT
  // ⇒ close + prune.
  it('closes and prunes when the open note is in BOTH lists but is GONE from disk (our push + peer tombstone)', async () => {
    vi.mocked(noteExists).mockResolvedValue(false); // tombstone won — file gone
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    const pruneTabsForDeletedIds = vi.fn();
    const toasts: string[] = [];
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'Contested',
        getEditorContent: () => 'MY PUSHED EDIT',
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
        pruneTabsForDeletedIds,
        showToast: (m) => toasts.push(m),
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        uploaded: 1,
        updatedIds: ['Contested'], // our own push echoed back
        deletedIds: ['Contested'], // peer tombstone applied by the pull
        peerDeletedIds: ['Contested'],
      },
      'poll',
    );

    expect(applyExternalContent).not.toHaveBeenCalled();
    expect(cancelAndClear).toHaveBeenCalledTimes(1);
    expect(toasts).toContain('Note was deleted during sync');
    expect(pruneTabsForDeletedIds).toHaveBeenCalledWith(['Contested']);
  });

  // W2: a peer-deleted note left open in a BACKGROUND tab would resurrect when
  // the user switches to it (loadNote reads "" → blank editor bound to the id →
  // first keystroke re-creates). Prune such tabs; exclude notes this sync
  // recreated (W1) and the open note whose draft was intentionally kept.
  it('prunes tabs only for deleted notes that are GONE from disk (recreated ones stay)', async () => {
    // BgGone: tombstoned, absent. Recreated: deleted then recreated, present.
    // updatedIds membership is irrelevant — existence decides.
    vi.mocked(noteExists).mockImplementation(async (id: string) => id === 'Recreated');
    const pruneTabsForDeletedIds = vi.fn();
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => null,
        pruneTabsForDeletedIds,
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        deletedIds: ['BgGone', 'Recreated'],
        updatedIds: ['Recreated'],
        peerDeletedIds: ['BgGone', 'Recreated'],
        peerUpdatedIds: ['Recreated'],
      },
      'poll',
    );

    expect(pruneTabsForDeletedIds).toHaveBeenCalledWith(['BgGone']);
  });

  it('prunes the closed active-note tab (no draft) so it cannot resurrect', async () => {
    const pruneTabsForDeletedIds = vi.fn();
    const cancelAndClear = vi.fn();
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'ClosedActive',
        isEditorFocused: () => false,
        cancelAndClear,
        pruneTabsForDeletedIds,
      }),
    );

    await mgr.handleSyncComplete(
      { ...emptySummary, deletedIds: ['ClosedActive'], peerDeletedIds: ['ClosedActive'] },
      'poll',
    );

    expect(cancelAndClear).toHaveBeenCalledTimes(1);
    expect(pruneTabsForDeletedIds).toHaveBeenCalledWith(['ClosedActive']);
  });

  it('does NOT prune the open note whose unsaved draft was kept', async () => {
    const pruneTabsForDeletedIds = vi.fn();
    const cancelAndClear = vi.fn();
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'DirtyDoomed',
        hasOpenDraftChanges: () => true,
        isEditorFocused: () => false,
        cancelAndClear,
        pruneTabsForDeletedIds,
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        deletedIds: ['DirtyDoomed', 'BgGone'],
        peerDeletedIds: ['DirtyDoomed', 'BgGone'],
      },
      'poll',
    );

    expect(cancelAndClear).not.toHaveBeenCalled();
    expect(pruneTabsForDeletedIds).toHaveBeenCalledWith(['BgGone']);
  });

  // P1-a: handleSyncComplete runs un-awaited from auto/live sync, so a rejected
  // existence probe must not become an unhandled rejection that leaves the
  // peer-deleted open note bound to its missing id. Fail safe: treat "cannot
  // confirm recreated" as deleted → close the clean session, skip pruning.
  it('closes cleanly (no unhandled rejection) when the existence check errors', async () => {
    vi.mocked(noteExists).mockRejectedValue(new Error('vault root unresolved'));
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    const pruneTabsForDeletedIds = vi.fn();
    const toasts: string[] = [];
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'Doomed',
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
        pruneTabsForDeletedIds,
        showToast: (m) => toasts.push(m),
      }),
    );

    await expect(
      mgr.handleSyncComplete(
        { ...emptySummary, deletedIds: ['Doomed'], peerDeletedIds: ['Doomed'] },
        'poll',
      ),
    ).resolves.toBeUndefined();

    expect(cancelAndClear).toHaveBeenCalledTimes(1);
    expect(applyExternalContent).not.toHaveBeenCalled();
    expect(toasts).toContain('Note was deleted during sync');
    // Prune probe also errored → skip pruning rather than crash or wrongly prune.
    expect(pruneTabsForDeletedIds).not.toHaveBeenCalled();
  });

  // P1-b TOCTOU: noteExists() says present, the file vanishes (external unlink /
  // overlapping live-sync cycle), then readNote() returns "" for the now-missing
  // file. Adopting that "" is the F4 shape again. Re-verify after the read.
  it('closes when a deleted-id note vanishes between the exists-check and the read (TOCTOU)', async () => {
    // present at the first check, gone at the re-verify.
    vi.mocked(noteExists).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(readNote).mockResolvedValue(''); // read after the file vanished
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    const toasts: string[] = [];
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'Vanisher',
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
        showToast: (m) => toasts.push(m),
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        deletedIds: ['Vanisher'],
        updatedIds: ['Vanisher'],
        peerDeletedIds: ['Vanisher'],
      },
      'poll',
    );

    expect(applyExternalContent).not.toHaveBeenCalled();
    expect(cancelAndClear).toHaveBeenCalledTimes(1);
    expect(toasts).toContain('Note was deleted during sync');
  });

  it('still adopts a legitimately-empty recreated note (re-verify says present)', async () => {
    // A deleted-then-recreated note that is genuinely empty must NOT be treated
    // as deleted — the re-verify confirms it is present, so adopt "".
    vi.mocked(noteExists).mockResolvedValue(true);
    vi.mocked(readNote).mockResolvedValue('');
    const applyExternalContent = vi.fn();
    const cancelAndClear = vi.fn();
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => 'EmptyRecreated',
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        applyExternalContent,
        cancelAndClear,
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        deletedIds: ['EmptyRecreated'],
        updatedIds: ['EmptyRecreated'],
        peerDeletedIds: ['EmptyRecreated'],
      },
      'poll',
    );

    expect(cancelAndClear).not.toHaveBeenCalled();
    expect(applyExternalContent).toHaveBeenCalledWith('');
  });

  // If the user switches/renames the active note WHILE an async probe (readNote
  // / re-verify) is pending, the active-note reconcile must bail — but that bail
  // must NOT abort the whole completion handler, or the tab-prune for OTHER
  // notes deleted this same sync never runs and a stale tab resurrects later
  // (defeating W2). The bail is scoped; pruning still runs.
  it('still prunes OTHER deleted notes when the active note is switched mid-probe', async () => {
    let openId: string | null = 'ActiveNote';
    // ActiveNote is present; OtherDeleted is gone.
    vi.mocked(noteExists).mockImplementation(async (id: string) => id !== 'OtherDeleted');
    // The user switches away DURING the active note's readNote probe.
    vi.mocked(readNote).mockImplementation(async () => {
      openId = 'SomethingElse';
      return '# fresh';
    });
    const pruneTabsForDeletedIds = vi.fn();
    const cancelAndClear = vi.fn();
    const mgr = createSyncManager(
      makeDeps({
        getOriginalId: () => openId,
        getEditorContent: () => 'OLD CONTENT',
        isEditorFocused: () => false,
        cancelAndClear,
        pruneTabsForDeletedIds,
      }),
    );

    await mgr.handleSyncComplete(
      {
        ...emptySummary,
        deletedIds: ['ActiveNote', 'OtherDeleted'],
        updatedIds: ['ActiveNote'],
        peerDeletedIds: ['ActiveNote', 'OtherDeleted'],
        peerUpdatedIds: ['ActiveNote'],
      },
      'poll',
    );

    // The active-note reconcile bailed (originalId changed mid-probe), but the
    // OTHER deleted-and-gone note is still pruned.
    expect(pruneTabsForDeletedIds).toHaveBeenCalledWith(['OtherDeleted']);
  });
});
