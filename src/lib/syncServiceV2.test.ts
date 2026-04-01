import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/platform');

const rustCoreMocks = vi.hoisted(() => ({
  hasRustCore: vi.fn(() => true),
  prepareSyncPayloadV2: vi.fn(),
  applySyncDeltaV2: vi.fn(),
}));

vi.mock('./rustCore', () => ({
  hasRustCore: rustCoreMocks.hasRustCore,
  prepareSyncPayloadV2: rustCoreMocks.prepareSyncPayloadV2,
  applySyncDeltaV2: rustCoreMocks.applySyncDeltaV2,
}));

import { testFS } from '$lib/platform';

let mockFetch: ReturnType<typeof vi.fn>;

async function freshModules() {
  vi.resetModules();
  const appState = await import('./appState');
  const syncServiceV2 = await import('./syncServiceV2');
  return { appState, syncServiceV2 };
}

beforeEach(() => {
  testFS._reset();
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  rustCoreMocks.hasRustCore.mockReturnValue(true);
  rustCoreMocks.prepareSyncPayloadV2.mockReset();
  rustCoreMocks.applySyncDeltaV2.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncServiceV2', () => {
  it('derives remote renames from matching delete/update hashes', async () => {
    const { syncServiceV2 } = await freshModules();

    expect(syncServiceV2.deriveRemoteRenames({
      previousFileHashes: {
        'old-name.md': 'same-hash',
        'untouched.md': 'other-hash',
      },
      updates: [
        { filename: 'new-name.md', hash: 'same-hash' },
        { filename: 'other.md', hash: 'different-hash' },
      ],
      deletes: ['old-name.md'],
    })).toEqual([{ fromId: 'old-name', toId: 'new-name' }]);
  });

  it('forces a full sync when the server version goes backwards', async () => {
    const { appState, syncServiceV2 } = await freshModules();

    await appState.loadAppState();
    await appState.updateAppState({ serverUrl: 'http://sync.example.com', authToken: 'test-token' });

    await appState.saveV2SyncState({
      deviceId: 'device-a',
      lastServerVersion: 5,
      fileHashes: {},
    });

    rustCoreMocks.prepareSyncPayloadV2.mockResolvedValue({
      nextState: {
        deviceId: 'device-a',
        lastServerVersion: 5,
        fileHashes: {},
      },
      inventory: [],
      changed: [],
      new: [],
      deleted: [],
      elapsedMs: 0,
    });
    rustCoreMocks.applySyncDeltaV2.mockResolvedValue({
      updatedFilenames: [],
      deletedFilenames: [],
      conflictFilenames: [],
      elapsedMs: 0,
    });

    mockFetch.mockResolvedValueOnce(
      Response.json({ status: 'up_to_date', version: 0 })
    );
    mockFetch.mockResolvedValueOnce(
      Response.json({
        update: [],
        delete: [],
        conflicts: [],
        version: 0,
      })
    );

    await syncServiceV2.syncNowV2();

    const urls = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('http://sync.example.com/sync');
  });

  it('does not pass non-markdown updates through the note apply path', async () => {
    const { appState, syncServiceV2 } = await freshModules();

    await appState.loadAppState();
    await appState.updateAppState({ serverUrl: 'http://sync.example.com', authToken: 'test-token' });

    await appState.saveV2SyncState({
      deviceId: 'device-a',
      lastServerVersion: 0,
      fileHashes: {},
    });

    rustCoreMocks.prepareSyncPayloadV2.mockResolvedValue({
      nextState: {
        deviceId: 'device-a',
        lastServerVersion: 0,
        fileHashes: {},
      },
      inventory: [],
      changed: [],
      new: [],
      deleted: [],
      elapsedMs: 0,
    });
    rustCoreMocks.applySyncDeltaV2.mockResolvedValue({
      updatedFilenames: ['photo.png'],
      deletedFilenames: [],
      conflictFilenames: [],
      elapsedMs: 0,
    });

    mockFetch.mockResolvedValueOnce(
      Response.json({
        update: [
          {
            filename: 'photo.png',
            content: '',
            hash: 'blob-hash',
            modified_at: 1_700_000_000_000,
          },
        ],
        delete: [],
        conflicts: [],
        version: 1,
      })
    );

    await syncServiceV2.syncNowV2();

    expect(rustCoreMocks.applySyncDeltaV2).not.toHaveBeenCalled();
  });

  it('returns rename summaries for remote delete-create renames', async () => {
    const { appState, syncServiceV2 } = await freshModules();

    await appState.loadAppState();
    await appState.updateAppState({ serverUrl: 'http://sync.example.com', authToken: 'test-token' });

    await appState.saveV2SyncState({
      deviceId: 'device-a',
      lastServerVersion: 1,
      fileHashes: {
        'old-name.md': 'same-hash',
      },
    });

    rustCoreMocks.prepareSyncPayloadV2.mockResolvedValue({
      nextState: {
        deviceId: 'device-a',
        lastServerVersion: 1,
        fileHashes: {
          'old-name.md': 'same-hash',
        },
      },
      inventory: [{ filename: 'old-name.md', hash: 'same-hash' }],
      changed: [],
      new: [],
      deleted: [],
      elapsedMs: 0,
    });
    rustCoreMocks.applySyncDeltaV2.mockResolvedValue({
      updatedFilenames: ['new-name.md'],
      deletedFilenames: ['old-name.md'],
      conflictFilenames: [],
      elapsedMs: 0,
    });

    mockFetch.mockResolvedValueOnce(
      Response.json({
        status: 'changes_available',
        version: 2,
      })
    );
    mockFetch.mockResolvedValueOnce(
      Response.json({
        update: [
          {
            filename: 'new-name.md',
            content: '# My Note',
            hash: 'same-hash',
            modified_at: 1_700_000_000_000,
          },
        ],
        delete: ['old-name.md'],
        conflicts: [],
        version: 2,
        timestamps: {},
      })
    );

    const summary = await syncServiceV2.syncNowV2();

    expect(summary.renamed).toEqual([{ fromId: 'old-name', toId: 'new-name' }]);
    expect(summary.updatedIds).toEqual([]);
    expect(summary.deletedIds).toEqual([]);
  });
});
