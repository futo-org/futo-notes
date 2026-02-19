import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('$lib/platform');

import { testFS } from '$lib/platform';
import {
  loadSyncState,
  saveSyncState,
  findIdForUuid,
  markLocalDeleteForSync,
  trackLocalRenameForSync,
  clearDeletedUuid,
  clearSyncState,
} from './syncState';

/** Reset module cache to get a fresh `cached = null` in syncState, then re-import. */
async function freshSyncState() {
  vi.resetModules();
  return import('./syncState');
}

beforeEach(() => {
  testFS._reset();
  return clearSyncState();
});

afterAll(() => {
  testFS._cleanup();
});

describe('loadSyncState', () => {
  it('returns defaults when no data exists', async () => {
    const state = await loadSyncState();
    expect(state).toEqual({
      hashByUuid: {},
      uuidById: {},
      deletedUuids: [],
    });
  });

  it('parses valid JSON from appData', async () => {
    const data = {
      hashByUuid: { 'uuid-1': 'hash-1' },
      uuidById: { 'note-1': 'uuid-1' },
      deletedUuids: ['uuid-2'],
    };
    await testFS.writeAppData('.sync-state-v1.json', JSON.stringify(data));
    const { loadSyncState: freshLoad } = await freshSyncState();
    const state = await freshLoad();
    expect(state).toEqual(data);
  });

  it('handles corrupt JSON gracefully', async () => {
    await testFS.writeAppData('.sync-state-v1.json', '{not valid json!!!');
    const { loadSyncState: freshLoad } = await freshSyncState();
    const state = await freshLoad();
    expect(state).toEqual({ hashByUuid: {}, uuidById: {}, deletedUuids: [] });
  });

  it('sanitizes partial/wrong-typed data', async () => {
    const bad = {
      hashByUuid: { good: 'hash', bad: 123 },
      uuidById: 'not-an-object',
      deletedUuids: ['ok', 42, null],
    };
    await testFS.writeAppData('.sync-state-v1.json', JSON.stringify(bad));
    const { loadSyncState: freshLoad } = await freshSyncState();
    const state = await freshLoad();
    expect(state.hashByUuid).toEqual({ good: 'hash' });
    expect(state.uuidById).toEqual({});
    expect(state.deletedUuids).toEqual(['ok']);
  });

  it('caches after first load', async () => {
    const state1 = await loadSyncState();
    state1.hashByUuid['mutated'] = 'yes';
    const state2 = await loadSyncState();
    expect(state2.hashByUuid['mutated']).toBe('yes');
  });
});

describe('saveSyncState', () => {
  it('persists to appData', async () => {
    const state = {
      hashByUuid: { u1: 'h1' },
      uuidById: { n1: 'u1' },
      deletedUuids: [],
    };
    await saveSyncState(state);
    const raw = await testFS.readAppData('.sync-state-v1.json');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(state);
  });

  it('round-trips with loadSyncState', async () => {
    const state = {
      hashByUuid: { u1: 'h1', u2: 'h2' },
      uuidById: { n1: 'u1', n2: 'u2' },
      deletedUuids: ['u3'],
    };
    await saveSyncState(state);
    const { loadSyncState: freshLoad } = await freshSyncState();
    const loaded = await freshLoad();
    expect(loaded).toEqual(state);
  });

  it('updates the module cache', async () => {
    const state = {
      hashByUuid: { x: 'y' },
      uuidById: {},
      deletedUuids: [],
    };
    await saveSyncState(state);
    const loaded = await loadSyncState();
    expect(loaded.hashByUuid).toEqual({ x: 'y' });
  });
});

describe('findIdForUuid', () => {
  it('finds mapped id', () => {
    const state = {
      hashByUuid: {},
      uuidById: { 'my-note': 'uuid-abc' },
      deletedUuids: [],
    };
    expect(findIdForUuid(state, 'uuid-abc')).toBe('my-note');
  });

  it('returns null for unmapped uuid', () => {
    const state = { hashByUuid: {}, uuidById: {}, deletedUuids: [] };
    expect(findIdForUuid(state, 'unknown')).toBeNull();
  });
});

describe('markLocalDeleteForSync', () => {
  it('adds to deletedUuids and removes from mappings', async () => {
    await saveSyncState({
      hashByUuid: { 'uuid-1': 'hash-1' },
      uuidById: { 'note-1': 'uuid-1' },
      deletedUuids: [],
    });

    await markLocalDeleteForSync('note-1');
    const state = await loadSyncState();
    expect(state.deletedUuids).toContain('uuid-1');
    expect(state.uuidById['note-1']).toBeUndefined();
    expect(state.hashByUuid['uuid-1']).toBeUndefined();
  });

  it('uses id as uuid when not mapped', async () => {
    await markLocalDeleteForSync('unmapped-note');
    const state = await loadSyncState();
    expect(state.deletedUuids).toContain('unmapped-note');
  });

  it('does not duplicate in deletedUuids', async () => {
    await saveSyncState({
      hashByUuid: {},
      uuidById: {},
      deletedUuids: ['already'],
    });
    await markLocalDeleteForSync('already');
    const state = await loadSyncState();
    expect(state.deletedUuids.filter((u) => u === 'already')).toHaveLength(1);
  });
});

describe('trackLocalRenameForSync', () => {
  it('moves UUID mapping from old to new id', async () => {
    await saveSyncState({
      hashByUuid: {},
      uuidById: { 'old-name': 'uuid-1' },
      deletedUuids: [],
    });
    await trackLocalRenameForSync('old-name', 'new-name');
    const state = await loadSyncState();
    expect(state.uuidById['new-name']).toBe('uuid-1');
    expect(state.uuidById['old-name']).toBeUndefined();
  });

  it('is a no-op when old id has no mapping', async () => {
    await trackLocalRenameForSync('no-mapping', 'new-name');
    const state = await loadSyncState();
    expect(state.uuidById).toEqual({});
  });
});

describe('clearDeletedUuid', () => {
  it('removes specific UUID from deletedUuids', async () => {
    await saveSyncState({
      hashByUuid: {},
      uuidById: {},
      deletedUuids: ['a', 'b', 'c'],
    });
    await clearDeletedUuid('b');
    const state = await loadSyncState();
    expect(state.deletedUuids).toEqual(['a', 'c']);
  });
});

describe('clearSyncState', () => {
  it('resets to empty defaults', async () => {
    await saveSyncState({
      hashByUuid: { u: 'h' },
      uuidById: { n: 'u' },
      deletedUuids: ['x'],
    });
    await clearSyncState();
    const state = await loadSyncState();
    expect(state).toEqual({ hashByUuid: {}, uuidById: {}, deletedUuids: [] });
  });
});
