import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('$lib/platform');
vi.mock('./rustCore');

const autoSyncSpies = vi.hoisted(() => ({
  pauseSyncV2: vi.fn(),
  resumeSyncV2: vi.fn(),
  waitForSyncIdleV2: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./autoSyncV2', () => ({
  pauseSyncV2: autoSyncSpies.pauseSyncV2,
  resumeSyncV2: autoSyncSpies.resumeSyncV2,
  waitForSyncIdleV2: autoSyncSpies.waitForSyncIdleV2,
}));

import { testFS } from '$lib/platform';

async function freshModules() {
  vi.resetModules();
  const notes = await import('./notes');
  const appState = await import('./appState');
  return { notes, appState };
}

beforeEach(() => {
  testFS._reset();
  autoSyncSpies.pauseSyncV2.mockReset();
  autoSyncSpies.resumeSyncV2.mockReset();
  autoSyncSpies.waitForSyncIdleV2.mockResolvedValue(undefined);
});

afterAll(() => {
  testFS._cleanup();
});

describe('deleteAllNotes (V2)', () => {
  it('uses the V2 auto-sync lifecycle during a full reset', async () => {
    const { notes } = await freshModules();

    await notes.deleteAllNotes();

    expect(autoSyncSpies.pauseSyncV2).toHaveBeenCalledTimes(1);
    expect(autoSyncSpies.waitForSyncIdleV2).toHaveBeenCalledTimes(1);
    expect(autoSyncSpies.resumeSyncV2).toHaveBeenCalledTimes(1);
  });

  it('clears the persisted V2 sync state', async () => {
    const { notes, appState } = await freshModules();

    await appState.saveV2SyncState({
      deviceId: 'device-a',
      lastServerVersion: 7,
      fileHashes: {
        'note-a.md': 'hash-a',
        'note-b.md': 'hash-b',
      },
    });

    await notes.deleteAllNotes();

    const state = await appState.loadV2SyncState();
    expect(state.lastServerVersion).toBe(0);
    expect(state.fileHashes).toEqual({});
  });
});
