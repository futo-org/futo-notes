import { describe, expect, it, vi, beforeEach } from 'vitest';

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

import { findActiveSyncRename, createSyncManager, getSyncErrorMessage } from './syncManager.svelte';
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
});
