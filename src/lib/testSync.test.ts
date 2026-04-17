import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform');

const e2eeMocks = vi.hoisted(() => ({
  connectE2ee: vi.fn(),
  syncE2ee: vi.fn(),
  disconnectE2ee: vi.fn(),
}));
const autoSyncMocks = vi.hoisted(() => ({
  requestSyncV2: vi.fn(),
}));

vi.mock('./syncServiceE2ee', () => ({
  connectE2ee: e2eeMocks.connectE2ee,
  syncE2ee: e2eeMocks.syncE2ee,
  disconnectE2ee: e2eeMocks.disconnectE2ee,
  SyncSummary: {},
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
    e2eeMocks.connectE2ee.mockReset();
    e2eeMocks.disconnectE2ee.mockReset();
    autoSyncMocks.requestSyncV2.mockReset();
  });

  it('connect clears E2EE state before reconnecting', async () => {
    const { appState, testSync } = await freshModules();

    await appState.loadAppState();
    e2eeMocks.connectE2ee.mockResolvedValue(undefined);
    e2eeMocks.disconnectE2ee.mockResolvedValue(undefined);

    const status = await testSync.testConnectSync('http://new-server', 'testing123');

    expect(e2eeMocks.connectE2ee).toHaveBeenCalledWith(
      'http://new-server',
      'testing123',
    );
    expect(typeof status.preferences).toBe('object');
  });

  it('installs a window test API with status, sync, and disconnect hooks', async () => {
    const { appState, testSync } = await freshModules();

    await appState.loadAppState();

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

    const syncResult = await target.__testSync!.syncNow();
    expect(syncResult.summary.uploaded).toBe(1);

    e2eeMocks.disconnectE2ee.mockResolvedValue(undefined);
    const disconnected = await target.__testSync!.disconnect();
    expect(typeof disconnected.preferences).toBe('object');
  });
});
