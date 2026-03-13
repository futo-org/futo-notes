import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SyncState } from './syncState';
import type { AppPreferences } from './preferences';
import type { HealthResponse, LoginResponse, SyncResponse, NoteSyncMeta } from '@futo-notes/shared';

// Mock all dependencies
vi.mock('$lib/platform');
vi.mock('./notes');
vi.mock('./preferences');
vi.mock('./syncState');
vi.mock('./rustCore', () => ({
  prepareSyncPayloadRust: vi.fn(),
  applySyncDeltaRust: vi.fn(),
}));

import { refreshNotesAfterSync } from './notes';
import { getCachedPreferences, savePreferences } from './preferences';
import { clearSyncState, loadSyncState, saveSyncState, findIdForUuid } from './syncState';
import { prepareSyncPayloadRust, applySyncDeltaRust } from './rustCore';
import { connectSyncServer, syncNow } from './sync';

const mockRefreshNotesAfterSync = vi.mocked(refreshNotesAfterSync);
const mockGetCachedPreferences = vi.mocked(getCachedPreferences);
const mockSavePreferences = vi.mocked(savePreferences);
const mockClearSyncState = vi.mocked(clearSyncState);
const mockLoadSyncState = vi.mocked(loadSyncState);
const mockSaveSyncState = vi.mocked(saveSyncState);
const mockFindIdForUuid = vi.mocked(findIdForUuid);
const mockPrepareSyncPayloadRust = vi.mocked(prepareSyncPayloadRust);
const mockApplySyncDeltaRust = vi.mocked(applySyncDeltaRust);

function makePrefs(overrides: Partial<AppPreferences['sync']> = {}): AppPreferences {
  return {
    appearance: { theme: 'auto' },
    crashReporting: { enabled: false, alwaysSend: false },
    sync: {
      serverUrl: 'https://sync.example.com',
      token: 'test-token',
      lastSyncedAt: null,
      lastError: '',
      ...overrides,
    },
  };
}

function makeState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    hashByUuid: {},
    uuidById: {},
    deletedUuids: [],
    ...overrides,
  };
}

// Mock fetch globally
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  // Default: preferences with server configured
  mockGetCachedPreferences.mockReturnValue(makePrefs());
  mockSavePreferences.mockResolvedValue();
  mockClearSyncState.mockResolvedValue();
  mockLoadSyncState.mockResolvedValue(makeState());
  mockSaveSyncState.mockResolvedValue();
  mockFindIdForUuid.mockReturnValue(null);
  mockRefreshNotesAfterSync.mockResolvedValue();
});

// ── connectSyncServer ───────────────────────────────────

describe('connectSyncServer', () => {
  it('calls /health, /setup (when not setup_complete), /login and saves token', async () => {
    mockFetch
      .mockResolvedValueOnce(
        Response.json({ status: 'ok', setup_complete: false } satisfies HealthResponse)
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ token: 'new-token' } satisfies LoginResponse)
      );

    mockGetCachedPreferences.mockReturnValue(makePrefs({ serverUrl: '', token: '' }));

    await connectSyncServer('https://sync.example.com/', 'password123');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('https://sync.example.com/health');
    expect(mockFetch.mock.calls[1][0]).toBe('https://sync.example.com/setup');
    expect(mockFetch.mock.calls[2][0]).toBe('https://sync.example.com/login');

    expect(mockSavePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: expect.objectContaining({
          serverUrl: 'https://sync.example.com',
          token: 'new-token',
        }),
      })
    );
  });

  it('skips /setup when already setup_complete', async () => {
    mockFetch
      .mockResolvedValueOnce(
        Response.json({ status: 'ok', setup_complete: true } satisfies HealthResponse)
      )
      .mockResolvedValueOnce(
        Response.json({ token: 'tok' } satisfies LoginResponse)
      );

    await connectSyncServer('https://sync.example.com', 'password123');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Should NOT have called /setup
    const urls = mockFetch.mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain(expect.stringContaining('/setup'));
  });

  it('throws on empty URL', async () => {
    await expect(connectSyncServer('', 'password123')).rejects.toThrow('Server URL is required');
  });

  it('throws on short password', async () => {
    await expect(connectSyncServer('https://sync.example.com', 'short')).rejects.toThrow(
      'Password must be at least 8 characters'
    );
  });

  it('propagates server errors', async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({ error: 'Server exploded' }, { status: 500 })
    );

    await expect(connectSyncServer('https://sync.example.com', 'password123')).rejects.toThrow(
      'Server exploded'
    );
  });
});

// ── syncNow ─────────────────────────────────────────────

describe('syncNow', () => {
  it('throws when no serverUrl configured', async () => {
    mockGetCachedPreferences.mockReturnValue(makePrefs({ serverUrl: '' }));
    await expect(syncNow()).rejects.toThrow('Set a sync server URL first');
  });

  it('throws when no token configured', async () => {
    mockGetCachedPreferences.mockReturnValue(makePrefs({ token: '' }));
    await expect(syncNow()).rejects.toThrow('Connect to server first');
  });

  it('clears stale sync state and reuploads when the server version goes backwards', async () => {
    const staleState = makeState({
      serverVersion: 10,
      hashByUuid: { 'uuid-hello': 'samehash' },
      uuidById: { hello: 'uuid-hello' },
    });
    const resetState = makeState();
    const syncNotes: NoteSyncMeta[] = [{
      uuid: 'uuid-hello',
      filename: 'hello.md',
      modified_at: 1700000000000,
      content_hash: 'samehash',
      hash_at_last_sync: '',
      content: 'Hello content',
    }];

    mockLoadSyncState
      .mockResolvedValueOnce(staleState)
      .mockResolvedValueOnce(resetState);
    mockFetch
      .mockResolvedValueOnce(Response.json({ status: 'changes_available', version: 0 } satisfies SyncCheckResponse))
      .mockResolvedValueOnce(Response.json({
        update: [],
        delete: [],
        hash_updates: [{ uuid: 'uuid-hello', hash_at_last_sync: 'samehash' }],
        conflicts: [],
        version: 1,
      } satisfies SyncResponse));
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: resetState,
      notes: syncNotes,
      allUuids: ['uuid-hello'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState({ serverVersion: 1 }),
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      elapsedMs: 1,
    });

    await syncNow();

    expect(mockClearSyncState).toHaveBeenCalledTimes(1);
    expect(mockPrepareSyncPayloadRust).toHaveBeenCalledWith(resetState);
    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].content).toBe('Hello content');
  });

  it('clears legacy sync state with UUID mappings when the server reports version 0', async () => {
    const staleState = makeState({
      hashByUuid: { 'uuid-hello': 'samehash' },
      uuidById: { hello: 'uuid-hello' },
    });
    const resetState = makeState();
    const syncNotes: NoteSyncMeta[] = [{
      uuid: 'uuid-hello',
      filename: 'hello.md',
      modified_at: 1700000000000,
      content_hash: 'samehash',
      hash_at_last_sync: '',
      content: 'Hello content',
    }];

    mockLoadSyncState
      .mockResolvedValueOnce(staleState)
      .mockResolvedValueOnce(resetState);
    mockFetch
      .mockResolvedValueOnce(Response.json({ status: 'up_to_date', version: 0 } satisfies SyncCheckResponse))
      .mockResolvedValueOnce(Response.json({
        update: [],
        delete: [],
        hash_updates: [{ uuid: 'uuid-hello', hash_at_last_sync: 'samehash' }],
        conflicts: [],
        version: 1,
      } satisfies SyncResponse));
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: resetState,
      notes: syncNotes,
      allUuids: ['uuid-hello'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState({ serverVersion: 1 }),
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      elapsedMs: 1,
    });

    await syncNow();

    expect(mockClearSyncState).toHaveBeenCalledTimes(1);
    expect(mockPrepareSyncPayloadRust).toHaveBeenCalledWith(resetState);
    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].content).toBe('Hello content');
  });

  it('detects a reset before syncing when stale state still has pending deletions', async () => {
    const staleState = makeState({
      serverVersion: 7,
      hashByUuid: { 'uuid-hello': 'samehash' },
      uuidById: { hello: 'uuid-hello' },
      deletedUuids: ['uuid-old-delete'],
    });
    const resetState = makeState();
    const syncNotes: NoteSyncMeta[] = [{
      uuid: 'uuid-hello',
      filename: 'hello.md',
      modified_at: 1700000000000,
      content_hash: 'samehash',
      hash_at_last_sync: '',
      content: 'Hello content',
    }];

    mockLoadSyncState
      .mockResolvedValueOnce(staleState)
      .mockResolvedValueOnce(resetState);
    mockFetch
      .mockResolvedValueOnce(Response.json({ status: 'changes_available', version: 0 } satisfies SyncCheckResponse))
      .mockResolvedValueOnce(Response.json({
        update: [],
        delete: [],
        hash_updates: [{ uuid: 'uuid-hello', hash_at_last_sync: 'samehash' }],
        conflicts: [],
        version: 1,
      } satisfies SyncResponse));
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: resetState,
      notes: syncNotes,
      allUuids: ['uuid-hello'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState({ serverVersion: 1 }),
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      elapsedMs: 1,
    });

    await syncNow();

    expect(mockClearSyncState).toHaveBeenCalledTimes(1);
    expect(mockPrepareSyncPayloadRust).toHaveBeenCalledWith(resetState);
    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(body.deleted_uuids).toEqual([]);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].content).toBe('Hello content');
  });

  it('sends Rust-prepared payload to server', async () => {
    const syncNotes: NoteSyncMeta[] = [{
      uuid: 'uuid-hello',
      filename: 'hello.md',
      modified_at: 1700000000000,
      content_hash: 'somehash',
      hash_at_last_sync: '',
      content: 'Hello content',
    }];

    mockLoadSyncState.mockResolvedValue(makeState({ uuidById: { hello: 'uuid-hello' } }));
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState({ uuidById: { hello: 'uuid-hello' } }),
      notes: syncNotes,
      allUuids: ['uuid-hello'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState({ uuidById: { hello: 'uuid-hello' } }),
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      elapsedMs: 1,
    });

    const syncResponse: SyncResponse = {
      update: [],
      delete: [],
      hash_updates: [{ uuid: 'uuid-hello', hash_at_last_sync: 'somehash' }],
      conflicts: [],
      version: 1,
    };
    mockFetch
      .mockResolvedValueOnce(Response.json({ status: 'changes_available', version: 1 } satisfies SyncCheckResponse))
      .mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('https://sync.example.com/sync/check');
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe('https://sync.example.com/sync');
    const body = JSON.parse(init.body);
    // V2 format: notes[] has only changed notes, inventory[] has all notes
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].uuid).toBe('uuid-hello');
    expect(body.notes[0].filename).toBe('hello.md');
    expect(body.notes[0].modified_at).toBe(1700000000000);
    expect(body.notes[0].content).toBe('Hello content');
    expect(body.inventory).toHaveLength(1);
    expect(body.inventory[0].uuid).toBe('uuid-hello');
    expect(body.inventory[0].content_hash).toBe('somehash');
    expect(body.inventory[0].filename).toBe('hello.md');
    expect(body.deleted_uuids).toEqual([]);
  });

  it('processes response.update via Rust delta apply', async () => {
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState(),
      notes: [],
      allUuids: [],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState(),
      updatedIds: ['new-note'],
      deletedIds: [],
      renamed: [],
      elapsedMs: 1,
    });

    const syncResponse: SyncResponse = {
      update: [
        {
          uuid: 'uuid-new',
          filename: 'new-note.md',
          modified_at: 1700000000000,
          content_hash: 'abc123',
          hash_at_last_sync: '',
          content: '# New Note\nBody here',
        },
      ],
      delete: [],
      hash_updates: [],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    const summary = await syncNow();

    expect(mockApplySyncDeltaRust).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({
        uuid: 'uuid-new',
        id: 'new-note',
        content: '# New Note\nBody here',
        modified_at: 1700000000000,
        content_hash: 'abc123',
      })],
      [],
    );
    expect(summary.downloaded).toBe(1);
    expect(summary.updatedIds).toEqual(['new-note']);
  });

  it('processes response.delete via Rust delta apply', async () => {
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState({ uuidById: { doomed: 'uuid-doomed' } }),
      notes: [{ uuid: 'uuid-doomed', filename: 'doomed.md', modified_at: 1700000000000, content_hash: 'h', hash_at_last_sync: '' }],
      allUuids: ['uuid-doomed'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState(),
      updatedIds: [],
      deletedIds: ['doomed'],
      renamed: [],
      elapsedMs: 1,
    });

    const syncResponse: SyncResponse = {
      update: [],
      delete: ['uuid-doomed'],
      hash_updates: [],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    const summary = await syncNow();

    expect(mockApplySyncDeltaRust).toHaveBeenCalledWith(
      expect.anything(),
      [],
      ['uuid-doomed'],
    );
    expect(summary.deleted).toBe(1);
    expect(summary.deletedIds).toEqual(['doomed']);
  });

  it('processes response.hash_updates — updates state hashes', async () => {
    mockLoadSyncState.mockResolvedValue(makeState({ uuidById: { hello: 'uuid-hello' } }));
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState({ uuidById: { hello: 'uuid-hello' } }),
      notes: [{ uuid: 'uuid-hello', filename: 'hello.md', modified_at: 1700000000000, content_hash: 'h', hash_at_last_sync: '' }],
      allUuids: ['uuid-hello'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState({ uuidById: { hello: 'uuid-hello' } }),
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      elapsedMs: 1,
    });

    const syncResponse: SyncResponse = {
      update: [],
      delete: [],
      hash_updates: [{ uuid: 'uuid-hello', hash_at_last_sync: 'newhash' }],
      conflicts: [],
      version: 1,
    };
    mockFetch
      .mockResolvedValueOnce(Response.json({ status: 'changes_available', version: 1 } satisfies SyncCheckResponse))
      .mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    expect(mockSaveSyncState).toHaveBeenCalled();
    const savedState = mockSaveSyncState.mock.calls[0][0];
    expect(savedState.hashByUuid['uuid-hello']).toBe('newhash');
  });

  it('records sync error in prefs on fetch failure', async () => {
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState(),
      notes: [],
      allUuids: [],
      elapsedMs: 1,
    });

    mockFetch.mockRejectedValueOnce(new Error('Network down'));

    await expect(syncNow()).rejects.toThrow('Network down');

    expect(mockSavePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: expect.objectContaining({
          lastError: 'Network down',
        }),
      })
    );
  });

  it('clears error and sets lastSyncedAt on success', async () => {
    const prefs = makePrefs({ lastError: 'old error' });
    mockGetCachedPreferences.mockReturnValue(prefs);
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState(),
      notes: [],
      allUuids: [],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState(),
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      elapsedMs: 1,
    });

    const syncResponse: SyncResponse = {
      update: [],
      delete: [],
      hash_updates: [],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    const lastCall = mockSavePreferences.mock.calls[mockSavePreferences.mock.calls.length - 1][0];
    expect(lastCall.sync.lastError).toBe('');
    expect(lastCall.sync.lastSyncedAt).toBeGreaterThan(0);
  });

  it('returns correct SyncSummary counts', async () => {
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState({ uuidById: { existing: 'uuid-existing', del: 'uuid-del' } }),
      notes: [
        { uuid: 'uuid-existing', filename: 'existing.md', modified_at: 1700000000000, content_hash: 'h1', hash_at_last_sync: '' },
        { uuid: 'uuid-del', filename: 'del.md', modified_at: 1700000000000, content_hash: 'h2', hash_at_last_sync: '' },
      ],
      allUuids: ['uuid-existing', 'uuid-del'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState(),
      updatedIds: ['downloaded'],
      deletedIds: ['del'],
      renamed: [],
      elapsedMs: 1,
    });

    const syncResponse: SyncResponse = {
      update: [
        {
          uuid: 'uuid-downloaded',
          filename: 'downloaded.md',
          modified_at: Date.now(),
          content_hash: 'h1',
          hash_at_last_sync: '',
          content: 'downloaded content',
        },
      ],
      delete: ['uuid-del'],
      hash_updates: [{ uuid: 'uuid-existing', hash_at_last_sync: 'h2' }],
      conflicts: [
        {
          uuid: 'uuid-conflict',
          server_filename: 's.md',
          client_filename: 'c.md',
          client_content: 'conflict',
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    const summary = await syncNow();
    expect(summary.uploaded).toBe(1); // hash_updates count
    expect(summary.downloaded).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(summary.conflicts).toBe(1);
    expect(summary.updatedIds).toContain('downloaded');
    expect(summary.deletedIds).toEqual(['del']);
    expect(summary.renamed).toEqual([]);
  });

  it('surfaces remote rename metadata in SyncSummary', async () => {
    mockPrepareSyncPayloadRust.mockResolvedValue({
      nextState: makeState({ uuidById: { old: 'uuid-note' } }),
      notes: [{ uuid: 'uuid-note', filename: 'old.md', modified_at: 1700000000000, content_hash: 'oldhash', hash_at_last_sync: 'oldhash' }],
      allUuids: ['uuid-note'],
      elapsedMs: 1,
    });
    mockApplySyncDeltaRust.mockResolvedValue({
      nextState: makeState({ uuidById: { renamed: 'uuid-note' } }),
      updatedIds: ['renamed'],
      deletedIds: [],
      renamed: [{ fromId: 'old', toId: 'renamed' }],
      elapsedMs: 1,
    });

    const syncResponse: SyncResponse = {
      update: [
        {
          uuid: 'uuid-note',
          filename: 'renamed.md',
          modified_at: 1700000000000,
          content_hash: 'oldhash',
          hash_at_last_sync: 'oldhash',
          content: 'body',
        },
      ],
      delete: [],
      hash_updates: [],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    const summary = await syncNow();

    expect(summary.updatedIds).toEqual(['renamed']);
    expect(summary.renamed).toEqual([{ fromId: 'old', toId: 'renamed' }]);
  });
});
