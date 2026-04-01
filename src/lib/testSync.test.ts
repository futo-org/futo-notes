import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform');

const syncServiceMocks = vi.hoisted(() => ({
  connectSyncServerV2: vi.fn(),
}));
const autoSyncMocks = vi.hoisted(() => ({
  requestSyncV2: vi.fn(),
}));

vi.mock('./syncServiceV2', () => ({
  connectSyncServerV2: syncServiceMocks.connectSyncServerV2,
}));

vi.mock('./autoSyncV2', () => ({
  requestSyncV2: autoSyncMocks.requestSyncV2,
}));

async function freshModules() {
  vi.resetModules();
  const appState = await import('./appState');
  const testSync = await import('./testSync');
  return { appState, testSync };
}

describe('testSync', () => {
  beforeEach(() => {
    syncServiceMocks.connectSyncServerV2.mockReset();
    autoSyncMocks.requestSyncV2.mockReset();
  });

  it('connect clears stale server-scoped state before reconnecting', async () => {
    const { appState, testSync } = await freshModules();

    await appState.loadAppState();
    await appState.saveAppState({
      ...appState.getAppState(),
      serverUrl: 'http://old-server',
      authToken: 'old-token',
      lastSyncedAt: 123,
      lastSyncError: 'boom',
      lastServerVersion: 42,
      fileHashes: { 'note.md': 'abc' },
      hashCache: { 'note.md': { modifiedAt: 1, hash: 'abc' } },
      graphLayout: {
        serverVersion: 42,
        data: { nodes: [], clusters: [], note_count: 0, indexed_count: 0 },
      },
    });

    syncServiceMocks.connectSyncServerV2.mockImplementation(async (serverUrl: string) => {
      expect(appState.getAppState().serverUrl).toBe('');
      expect(appState.getAppState().authToken).toBe('');
      expect(appState.getAppState().lastServerVersion).toBe(0);
      expect(appState.getAppState().fileHashes).toEqual({});
      expect(appState.getAppState().graphLayout).toBeUndefined();

      await appState.updateAppState({ serverUrl, authToken: 'new-token' });
    });

    const status = await testSync.testConnectSync('http://new-server', 'testing123');

    expect(syncServiceMocks.connectSyncServerV2).toHaveBeenCalledWith(
      'http://new-server',
      'testing123',
    );
    expect(status.preferences.sync.serverUrl).toBe('http://new-server');
    expect(status.preferences.sync.token).toBe('new-token');
    expect(status.appState.lastServerVersion).toBe(0);
  });

  it('installs a window test API with status, sync, and disconnect hooks', async () => {
    const { appState, testSync } = await freshModules();

    await appState.loadAppState();
    await appState.updateAppState({
      serverUrl: 'http://server',
      authToken: 'token',
      lastServerVersion: 7,
      fileHashes: { 'note.md': 'hash' },
    });

    autoSyncMocks.requestSyncV2.mockResolvedValue({
      uploaded: 1,
      downloaded: 2,
      deleted: 0,
      conflicts: 0,
      updatedIds: ['note'],
      deletedIds: [],
      renamed: [],
    });

    const target = {} as Window;
    testSync.installTestSync(target);

    expect(typeof target.__testSync?.status).toBe('function');
    expect(target.__testSync?.status().preferences.sync.serverUrl).toBe('http://server');

    const syncResult = await target.__testSync!.syncNow();
    expect(syncResult.summary.uploaded).toBe(1);

    const disconnected = await target.__testSync!.disconnect();
    expect(disconnected.preferences.sync.serverUrl).toBe('');
    expect(disconnected.preferences.sync.token).toBe('');
    expect(disconnected.appState.lastServerVersion).toBe(0);
    expect(disconnected.appState.fileHashes).toEqual({});
  });
});
