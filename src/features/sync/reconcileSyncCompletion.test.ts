import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncSummary } from './syncServiceE2ee';

const noteMocks = vi.hoisted(() => ({
  refreshNotesAfterSync: vi.fn(async () => undefined),
}));

vi.mock('$features/notes/notes.svelte', () => ({
  getNoteById: () => undefined,
  noteExists: async () => true,
  refreshNotesAfterSync: noteMocks.refreshNotesAfterSync,
}));
vi.mock('$lib/localNoteStore', () => ({
  getLocalNoteStore: async () => ({ rescan: vi.fn() }),
}));
vi.mock('$shared/state/appState', () => ({
  updateAppState: async () => undefined,
}));

const { createSyncCompletionReconciler } = await import('./reconcileSyncCompletion');

function emptySummary(): SyncSummary {
  return {
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    localWritesApplied: 0,
    failures: [],
    failureMessage: null,
    updatedIds: [],
    deletedIds: [],
    peerUpdatedIds: [],
    peerDeletedIds: [],
    renamed: [],
  };
}

function controlledPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeReconciler(
  reconcileOpenNote = vi.fn(async () => ({
    followedRenameTo: null,
    keptDraftId: null,
  })),
) {
  const session = {
    originalId: 'Merged',
    editVersion: 0,
    savePending: false,
  };
  const run = createSyncCompletionReconciler({
    clearSyncError: vi.fn(),
    dependencies: {
      session: session as never,
      showToast: vi.fn(),
      onRename: vi.fn(),
      pruneTabsForDeletedIds: vi.fn(),
    },
    externalChanges: {
      reconcileOpenNote,
      runRescan: vi.fn(async () => undefined),
    } as never,
    getSyncStartEditVersion: () => 0,
    raiseSyncError: vi.fn(),
    setCompletionStatus: vi.fn(),
    setSyncStatusMessage: vi.fn(),
    writeSuppressor: {
      recordSyncWrite: vi.fn(),
      recordRemoteRename: vi.fn(),
    } as never,
  });
  return { run, reconcileOpenNote };
}

describe('sync completion projection', () => {
  beforeEach(() => {
    noteMocks.refreshNotesAfterSync.mockReset();
    noteMocks.refreshNotesAfterSync.mockResolvedValue(undefined);
  });

  it('awaits the complete engine mutation before reconciling the open note', async () => {
    const refresh = controlledPromise();
    noteMocks.refreshNotesAfterSync.mockReturnValueOnce(refresh.promise);
    const { run, reconcileOpenNote } = makeReconciler();
    const summary = {
      ...emptySummary(),
      localWritesApplied: 1,
      updatedIds: ['Merged'],
      deletedIds: ['Gone'],
      renamed: [{ fromId: 'Old', toId: 'New' }],
    };

    const completion = run(summary);
    await Promise.resolve();
    await Promise.resolve();

    expect(noteMocks.refreshNotesAfterSync).toHaveBeenCalledExactlyOnceWith(
      ['Merged'],
      ['Gone'],
      [{ fromId: 'Old', toId: 'New' }],
    );
    expect(reconcileOpenNote).not.toHaveBeenCalled();

    refresh.resolve();
    await completion;
    expect(reconcileOpenNote).toHaveBeenCalledOnce();
  });

  it('does not touch the projection when the cycle wrote nothing locally', async () => {
    const { run } = makeReconciler();

    await run(emptySummary());

    expect(noteMocks.refreshNotesAfterSync).not.toHaveBeenCalled();
  });
});
