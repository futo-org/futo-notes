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

  it('preserves hash cache after full sync', async () => {
    const { appState, syncServiceV2 } = await freshModules();

    await appState.loadAppState();
    await appState.updateAppState({ serverUrl: 'http://sync.example.com', authToken: 'test-token' });

    await appState.saveV2SyncState({
      deviceId: 'device-a',
      lastServerVersion: 0,
      fileHashes: {},
    });

    const expectedHashCache = { 'note.md': { modifiedAt: 1_700_000_000_000, hash: 'abc123' } };

    rustCoreMocks.prepareSyncPayloadV2.mockResolvedValue({
      nextState: {
        deviceId: 'device-a',
        lastServerVersion: 0,
        fileHashes: {},
        hashCache: expectedHashCache,
      },
      inventory: [],
      changed: [],
      new: [],
      deleted: [],
      elapsedMs: 0,
    });

    mockFetch.mockResolvedValueOnce(
      Response.json({
        update: [],
        delete: [],
        conflicts: [],
        version: 1,
      })
    );

    await syncServiceV2.syncNowV2();

    const savedState = await appState.loadV2SyncState();
    expect(savedState.hashCache).toEqual(expectedHashCache);
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

  it('infers rename summaries for stale-state collision reconciliation', async () => {
    const { appState, syncServiceV2 } = await freshModules();

    await appState.loadAppState();
    await appState.updateAppState({ serverUrl: 'http://sync.example.com', authToken: 'test-token' });

    await appState.saveV2SyncState({
      deviceId: 'device-a',
      lastServerVersion: 1,
      fileHashes: {},
    });

    rustCoreMocks.prepareSyncPayloadV2.mockResolvedValue({
      nextState: {
        deviceId: 'device-a',
        lastServerVersion: 1,
        fileHashes: {},
      },
      inventory: [
        { filename: 'note.md', hash: 'client-hash' },
      ],
      changed: [],
      new: [
        { filename: 'note.md', content: '# Client version', hash: 'client-hash' },
      ],
      deleted: [],
      elapsedMs: 0,
    });
    rustCoreMocks.applySyncDeltaV2.mockResolvedValue({
      updatedFilenames: ['note.md', 'note (2).md'],
      deletedFilenames: ['note.md'],
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
            filename: 'note.md',
            content: '# Server version',
            hash: 'server-hash',
            modified_at: 1_700_000_000_000,
          },
          {
            filename: 'note (2).md',
            content: '# Client version',
            hash: 'client-hash',
            modified_at: 1_700_000_000_001,
          },
        ],
        delete: ['note.md'],
        conflicts: [],
        version: 2,
        timestamps: {},
      })
    );

    const summary = await syncServiceV2.syncNowV2();

    expect(summary.renamed).toEqual([{ fromId: 'note', toId: 'note (2)' }]);
    expect(summary.deletedIds).toEqual([]);
    expect(summary.updatedIds).toEqual(['note']);
  });

  it('does not infer a collision rename without a matching local new note', async () => {
    const { appState, syncServiceV2 } = await freshModules();

    await appState.loadAppState();
    await appState.updateAppState({ serverUrl: 'http://sync.example.com', authToken: 'test-token' });

    await appState.saveV2SyncState({
      deviceId: 'device-a',
      lastServerVersion: 1,
      fileHashes: {},
    });

    rustCoreMocks.prepareSyncPayloadV2.mockResolvedValue({
      nextState: {
        deviceId: 'device-a',
        lastServerVersion: 1,
        fileHashes: {},
      },
      inventory: [],
      changed: [],
      new: [],
      deleted: [],
      elapsedMs: 0,
    });
    rustCoreMocks.applySyncDeltaV2.mockResolvedValue({
      updatedFilenames: ['note.md', 'note (2).md'],
      deletedFilenames: ['note.md'],
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
            filename: 'note.md',
            content: '# Server version',
            hash: 'server-hash',
            modified_at: 1_700_000_000_000,
          },
          {
            filename: 'note (2).md',
            content: '# Client version',
            hash: 'client-hash',
            modified_at: 1_700_000_000_001,
          },
        ],
        delete: ['note.md'],
        conflicts: [],
        version: 2,
        timestamps: {},
      })
    );

    const summary = await syncServiceV2.syncNowV2();

    expect(summary.renamed).toEqual([]);
    expect(summary.deletedIds).toEqual(['note']);
    expect(summary.updatedIds).toEqual(['note', 'note (2)']);
  });
});
