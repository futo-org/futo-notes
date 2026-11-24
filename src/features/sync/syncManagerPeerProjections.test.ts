// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  controlledPromise,
  emptySummary,
  makeManager,
  makeSession,
  openNoteMocks,
  resetSyncManagerHarness,
  yieldMicrotasks,
} from './__test__/syncManagerHarness';
import { updateAppState } from '$shared/state/appState';

beforeEach(resetSyncManagerHarness);

afterEach(() => {
  vi.useRealTimers();
});

describe('sync outcome source clearing', () => {
  it('a clean poll cannot clear or re-toast a still-broken stream', async () => {
    const { manager, toasts } = makeManager();
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    await manager.handleSyncComplete(emptySummary, 'poll');
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    expect(manager.syncError).toBe(true);
    expect(toasts).toEqual([{ path: 'sync.errors.liveUnavailable' }]);
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
    expect(toasts).toEqual([{ path: 'sync.status.complete' }]);
  });

  it('stamps lastSyncedAt for every completed cycle', async () => {
    const { manager } = makeManager();
    await manager.handleSyncComplete(emptySummary, 'poll');
    expect(updateAppState).toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
  });
});

describe('peer projections', () => {
  it('brings the session to where the store moved the open note before classifying it', async () => {
    // The pull moved the editor's attachment with the note; following only the
    // summary afterwards let a save land at the id the note left, and the store
    // recreated it there: a ghost that synced to every device.
    const sessionBundle = makeSession({ id: 'Old', content: 'draft', relocatedTo: 'New' });
    const bundle = makeManager(sessionBundle);

    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['New'],
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });

    expect(sessionBundle.checkpointEditor).toHaveBeenCalledOnce();
    expect(bundle.state.id).toBe('New');
    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'New', renamedTo: null }),
    );
    expect(bundle.onRename).toHaveBeenCalledExactlyOnceWith('Old', 'New');
  });

  // A first sync's ancestry relocation reports only the source's delete.
  it('follows a relocation reported only as its source deleted, never closing the note', async () => {
    const sessionBundle = makeSession({ id: 'Old', content: 'draft', relocatedTo: 'New' });
    const bundle = makeManager(sessionBundle);

    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['New'],
      deletedIds: ['Old'],
      peerDeletedIds: ['Old'],
    });

    expect(bundle.state.id).toBe('New');
    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'New' }),
    );
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  it('never moves a session the store did not move', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'followRename', toId: 'New' });
    const bundle = makeManager(makeSession({ id: 'Old', content: 'draft' }));

    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });

    expect(bundle.state.id).toBe('Old');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  // Same-cycle collision placement + tombstone of the relocated note: the
  // engine reports both the rename and the deletion of its target (guarded by
  // same_cycle_tombstone_of_a_collision_relocated_note_survives_ghost_stripping
  // in futo-notes-sync). The session follows the editor to the target, then the
  // deleted-during-sync flow closes it instead of leaving the editor bound to a
  // nonexistent note whose next save would resurrect the tombstoned object.
  it('closes the open note when its relocation target was tombstoned in the same cycle', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'close' });
    const copy = 'Old (conflict deadbeef)';
    const bundle = makeManager(makeSession({ id: 'Old', content: 'body', relocatedTo: copy }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Old'],
      deletedIds: [copy],
      peerUpdatedIds: ['Old'],
      peerDeletedIds: [copy],
      renamed: [{ fromId: 'Old', toId: copy }],
    });
    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: copy }),
    );
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.toasts).toContainEqual({ path: 'notes.deletedElsewhere' });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith([copy]);
  });

  // Same-cycle collision placement + a real peer edit to the relocated object:
  // the engine reports the rename AND keeps the update against its target id
  // (guarded by same_cycle_update_of_a_collision_relocated_note_survives_ghost_stripping
  // in futo-notes-sync). The session follows, then the fresh peer content is
  // adopted — without it the editor keeps the stale relocated draft and the next
  // save overwrites the peer edit on every client.
  it('reloads a relocation target that also received a real update in the same cycle', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' });
    const copy = 'Old (conflict deadbeef)';
    const bundle = makeManager(makeSession({ id: 'Old', content: 'stale', relocatedTo: copy }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: [copy],
      peerUpdatedIds: [copy],
      renamed: [{ fromId: 'Old', toId: copy }],
    });
    expect(bundle.state.id).toBe(copy);
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });
});

describe('rename disposition races', () => {
  it('bounds a reported rename cycle to one pass per note id', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'followRename', toId: 'New' })
      .mockResolvedValueOnce({ kind: 'followRename', toId: 'Old' });
    const bundle = makeManager(makeSession({ id: 'Old', content: 'body' }));

    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      renamed: [
        { fromId: 'Old', toId: 'New' },
        { fromId: 'New', toId: 'Old' },
      ],
    });

    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledOnce();
    expect(bundle.state.id).toBe('Old');
  });

  it('renames the tabs of a note the session left during classification', async () => {
    const verdict = controlledPromise<{
      kind: 'followRename';
      toId: string;
    }>();
    openNoteMocks.classifyOpenNote.mockReturnValueOnce(verdict.promise);
    const bundle = makeManager(makeSession({ id: 'Old', content: 'body' }));

    const reconciliation = bundle.manager.handleSyncComplete({
      ...emptySummary,
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });
    await yieldMicrotasks();
    bundle.state.id = 'Other';
    verdict.resolve({ kind: 'followRename', toId: 'New' });
    await reconciliation;

    expect(bundle.state.id).toBe('Other');
    expect(bundle.onRename).toHaveBeenCalledExactlyOnceWith('Old', 'New');
  });
});
