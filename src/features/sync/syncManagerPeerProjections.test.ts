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
  it('follows a reported rename before a pending save persists', async () => {
    // Flushing first addressed the save to the id the note just left, and the
    // store recreated the note there: a ghost that synced to every device. The
    // pending save is settled only once the editor is bound to the new id.
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'followRename',
      toId: 'New',
    });
    const sessionBundle = makeSession({
      id: 'Old',
      content: 'draft',
      savedContent: 'base',
      savePending: true,
    });
    const bundle = makeManager(sessionBundle);

    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });

    expect(bundle.applyRemoteRename).toHaveBeenCalledExactlyOnceWith('New', 'New');
    const flushSave = vi.mocked(sessionBundle.session.flushSave);
    expect(flushSave).toHaveBeenCalledOnce();
    expect(bundle.applyRemoteRename.mock.invocationCallOrder[0]).toBeLessThan(
      flushSave.mock.invocationCallOrder[0],
    );
  });

  it('does not rebind a remote rename after the session switches notes', async () => {
    const verdict = controlledPromise<{ kind: 'followRename'; toId: string }>();
    openNoteMocks.classifyOpenNote.mockReturnValueOnce(verdict.promise);
    const sessionBundle = makeSession({ id: 'Old', content: 'draft', savePending: true });
    const bundle = makeManager(sessionBundle);

    const reconciliation = bundle.manager.handleSyncComplete({
      ...emptySummary,
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });
    await vi.waitFor(() => expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledOnce());
    sessionBundle.state.id = 'Other';
    verdict.resolve({ kind: 'followRename', toId: 'New' });
    await reconciliation;

    expect(bundle.applyRemoteRename).not.toHaveBeenCalled();
  });

  // Same-cycle collision placement + tombstone of the relocated note: the
  // engine reports both the rename and the deletion of its target (guarded by
  // same_cycle_tombstone_of_a_collision_relocated_note_survives_ghost_stripping
  // in futo-notes-sync). The tab follows the rename, then the deleted-during-
  // sync flow closes it instead of leaving the editor bound to a nonexistent
  // note whose next save would resurrect the tombstoned object.
  it('closes the open note when a followed rename target was tombstoned in the same cycle', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({
        kind: 'followRename',
        toId: 'Old (conflict deadbeef)',
      })
      .mockResolvedValueOnce({ kind: 'close' });
    const bundle = makeManager(makeSession({ id: 'Old', content: 'body' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Old'],
      deletedIds: ['Old (conflict deadbeef)'],
      peerUpdatedIds: ['Old'],
      peerDeletedIds: ['Old (conflict deadbeef)'],
      renamed: [{ fromId: 'Old', toId: 'Old (conflict deadbeef)' }],
    });
    expect(bundle.applyRemoteRename).toHaveBeenCalledWith(
      'Old (conflict deadbeef)',
      'Old (conflict deadbeef)',
    );
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.toasts).toContainEqual({ path: 'notes.deletedElsewhere' });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Old (conflict deadbeef)']);
  });

  // Same-cycle collision placement + a real peer edit to the relocated object:
  // the engine reports the rename AND keeps the update against its target id
  // (guarded by same_cycle_update_of_a_collision_relocated_note_survives_ghost_stripping
  // in futo-notes-sync). The tab follows the rename, then the fresh peer content
  // is adopted — without it the editor keeps the stale relocated draft and the
  // next save overwrites the peer edit on every client.
  it('reloads a followed rename target that also received a real update in the same cycle', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({
        kind: 'followRename',
        toId: 'Old (conflict deadbeef)',
      })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' });
    const bundle = makeManager(makeSession({ id: 'Old', content: 'stale' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Old (conflict deadbeef)'],
      peerUpdatedIds: ['Old (conflict deadbeef)'],
      renamed: [{ fromId: 'Old', toId: 'Old (conflict deadbeef)' }],
    });
    expect(bundle.applyRemoteRename).toHaveBeenCalledWith(
      'Old (conflict deadbeef)',
      'Old (conflict deadbeef)',
    );
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

    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledTimes(2);
    expect(bundle.state.id).toBe('Old');
  });

  it('retargets a renamed tab without rebinding a session that switched during classification', async () => {
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

    expect(bundle.applyRemoteRename).not.toHaveBeenCalled();
    expect(bundle.onRename).toHaveBeenCalledExactlyOnceWith('Old', 'New', 'New');
  });
});
