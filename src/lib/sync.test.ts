import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SyncState } from './syncState';
import type { AppPreferences } from './preferences';
import type { NotePreview } from '../types';
import type { HealthResponse, LoginResponse, SyncResponse } from '@futo-notes/shared';

// Mock all dependencies
vi.mock('$lib/platform');
vi.mock('./notes');
vi.mock('./preferences');
vi.mock('./syncState');

import { getAllNotes, getNoteById, readNote, updateNote, deleteNote } from './notes';
import { getCachedPreferences, savePreferences } from './preferences';
import { loadSyncState, saveSyncState, findIdForUuid } from './syncState';
import { connectSyncServer, syncNow } from './sync';

const mockGetAllNotes = vi.mocked(getAllNotes);
const mockGetNoteById = vi.mocked(getNoteById);
const mockReadNote = vi.mocked(readNote);
const mockUpdateNote = vi.mocked(updateNote);
const mockDeleteNote = vi.mocked(deleteNote);
const mockGetCachedPreferences = vi.mocked(getCachedPreferences);
const mockSavePreferences = vi.mocked(savePreferences);
const mockLoadSyncState = vi.mocked(loadSyncState);
const mockSaveSyncState = vi.mocked(saveSyncState);
const mockFindIdForUuid = vi.mocked(findIdForUuid);

function makePrefs(overrides: Partial<AppPreferences['sync']> = {}): AppPreferences {
  return {
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

function makeNote(id: string, mtime = Date.now()): NotePreview {
  return {
    id,
    title: id.charAt(0).toUpperCase() + id.slice(1),
    preview: `Content of ${id}`,
    modificationTime: mtime,
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
  mockLoadSyncState.mockResolvedValue(makeState());
  mockSaveSyncState.mockResolvedValue();
  mockDeleteNote.mockResolvedValue();
  mockFindIdForUuid.mockReturnValue(null);
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

  it('builds correct SyncRequest from local notes', async () => {
    const note = makeNote('hello', 1700000000000);
    mockGetAllNotes.mockReturnValue([note]);
    mockReadNote.mockResolvedValue('Hello content');
    mockLoadSyncState.mockResolvedValue(makeState({ uuidById: { hello: 'uuid-hello' } }));

    const syncResponse: SyncResponse = {
      update: [],
      delete: [],
      hash_updates: [{ uuid: 'uuid-hello', hash_at_last_sync: 'somehash' }],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://sync.example.com/sync');
    const body = JSON.parse(init.body);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].uuid).toBe('uuid-hello');
    expect(body.notes[0].filename).toBe('hello.md');
    expect(body.notes[0].modified_at).toBe(1700000000000);
    // Content should be included since hash differs from empty hash_at_last_sync
    expect(body.notes[0].content).toBe('Hello content');
    expect(body.all_uuids).toEqual(['uuid-hello']);
    expect(body.deleted_uuids).toEqual([]);
  });

  it('excludes content when hash matches hash_at_last_sync', async () => {
    const note = makeNote('hello', 1700000000000);
    mockGetAllNotes.mockReturnValue([note]);
    mockReadNote.mockResolvedValue('Hello content');

    // We need a hash that matches. Compute sha256 of 'Hello content'
    const hashBytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('Hello content')
    );
    const hash = Array.from(new Uint8Array(hashBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    mockLoadSyncState.mockResolvedValue(
      makeState({
        uuidById: { hello: 'uuid-hello' },
        hashByUuid: { 'uuid-hello': hash },
      })
    );

    const syncResponse: SyncResponse = {
      update: [],
      delete: [],
      hash_updates: [],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // content_hash === hash_at_last_sync, so content should NOT be included
    expect(body.notes[0].content).toBeUndefined();
  });

  it('processes response.update — calls updateNote with modified_at', async () => {
    mockGetAllNotes.mockReturnValue([]);
    mockLoadSyncState.mockResolvedValue(makeState());
    mockUpdateNote.mockResolvedValue({ id: 'new-note', mtime: 1700000000000 });

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

    await syncNow();

    expect(mockUpdateNote).toHaveBeenCalledWith(
      'new-note',
      'new-note',
      '# New Note\nBody here',
      undefined, // no originalId since findIdForUuid returns null
      1700000000000 // modified_at passed through
    );
  });

  it('processes response.delete — calls deleteNote with trackSyncDelete: false', async () => {
    const note = makeNote('doomed');
    mockGetAllNotes.mockReturnValue([note]);
    mockReadNote.mockResolvedValue('content');
    mockGetNoteById.mockReturnValue(note);
    mockLoadSyncState.mockResolvedValue(
      makeState({ uuidById: { doomed: 'uuid-doomed' } })
    );

    const syncResponse: SyncResponse = {
      update: [],
      delete: ['uuid-doomed'],
      hash_updates: [],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    expect(mockDeleteNote).toHaveBeenCalledWith('doomed', { trackSyncDelete: false });
  });

  it('processes response.hash_updates — updates state hashes', async () => {
    const note = makeNote('hello');
    mockGetAllNotes.mockReturnValue([note]);
    mockReadNote.mockResolvedValue('content');

    const state = makeState({ uuidById: { hello: 'uuid-hello' } });
    mockLoadSyncState.mockResolvedValue(state);

    const syncResponse: SyncResponse = {
      update: [],
      delete: [],
      hash_updates: [{ uuid: 'uuid-hello', hash_at_last_sync: 'newhash' }],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    expect(mockSaveSyncState).toHaveBeenCalled();
    const savedState = mockSaveSyncState.mock.calls[0][0];
    expect(savedState.hashByUuid['uuid-hello']).toBe('newhash');
  });

  it('records sync error in prefs on fetch failure', async () => {
    mockGetAllNotes.mockReturnValue([]);
    mockLoadSyncState.mockResolvedValue(makeState());
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
    mockGetAllNotes.mockReturnValue([]);
    mockLoadSyncState.mockResolvedValue(makeState());
    const prefs = makePrefs({ lastError: 'old error' });
    mockGetCachedPreferences.mockReturnValue(prefs);

    const syncResponse: SyncResponse = {
      update: [],
      delete: [],
      hash_updates: [],
      conflicts: [],
    };
    mockFetch.mockResolvedValueOnce(Response.json(syncResponse));

    await syncNow();

    // savePreferences is called twice: once by setSyncError path (not called here) and once by clearSyncErrorAndSetTime
    const lastCall = mockSavePreferences.mock.calls[mockSavePreferences.mock.calls.length - 1][0];
    expect(lastCall.sync.lastError).toBe('');
    expect(lastCall.sync.lastSyncedAt).toBeGreaterThan(0);
  });

  it('returns correct SyncSummary counts', async () => {
    const note = makeNote('existing');
    const delNote = makeNote('del');
    mockGetAllNotes.mockReturnValue([note, delNote]);
    mockReadNote.mockResolvedValue('content');
    mockGetNoteById.mockImplementation((id) => (id === 'del' ? delNote : undefined));
    mockUpdateNote.mockResolvedValue({ id: 'downloaded', mtime: Date.now() });

    const state = makeState({
      uuidById: { existing: 'uuid-existing', del: 'uuid-del' },
    });
    mockLoadSyncState.mockResolvedValue(state);

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
    expect(summary.updatedIds).toEqual(['downloaded']);
    expect(summary.deletedIds).toEqual(['del']);
  });
});
