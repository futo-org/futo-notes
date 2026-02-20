/**
 * Client-server contract tests.
 *
 * These tests run the real server (Hono + SQLite) in-process and bridge
 * `fetch` to `app.request()`, so the client's `sync.ts` talks to the
 * actual server sync engine — no HTTP, no mocks for the server side.
 *
 * The client side uses the nodeFS test double for file storage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestEnv, setupAndLogin, type TestEnv } from '@futo-notes/server-test/setup';

vi.mock('$lib/platform');

import { testFS, setActiveFS, resetActiveFS, createNodeFS, type TestPlatformFS } from '$lib/platform';

let env: TestEnv;

/** Import fresh client module instances (notes.ts has module-level cache). */
async function freshClient() {
  vi.resetModules();
  const notes = await import('./notes');
  const sync = await import('./sync');
  const syncState = await import('./syncState');
  const prefs = await import('./preferences');
  return { notes, sync, syncState, prefs };
}

beforeEach(async () => {
  testFS._reset();
  env = createTestEnv();

  // Bridge client's fetch calls to the in-process Hono app
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    return env.app.request(input as string, init);
  });
});

afterEach(() => {
  resetActiveFS();
  env.cleanup();
  vi.unstubAllGlobals();
});

/** Helper: set up server auth and configure client preferences. */
async function setupClient(client: Awaited<ReturnType<typeof freshClient>>) {
  await client.notes.initNotes();
  await client.prefs.loadPreferences();
  await client.syncState.clearSyncState();

  // Use connectSyncServer which calls /health, /setup, /login
  await client.sync.connectSyncServer('http://localhost', 'testpassword123');
}

/** Helper: create a second client (fresh FS, login only). */
async function freshClient2() {
  testFS._reset();
  const client2 = await freshClient();
  await client2.notes.initNotes();
  await client2.prefs.loadPreferences();
  await client2.sync.connectSyncServer('http://localhost', 'testpassword123');
  return client2;
}

describe('client-server contract', () => {
  it('full round-trip: create local note, sync up, verify on server', async () => {
    const client = await freshClient();
    await setupClient(client);

    // Create a local note
    await client.notes.createNote('hello', '# Hello\nWorld');

    // Sync
    const summary = await client.sync.syncNow();
    expect(summary.uploaded).toBe(1);
    expect(summary.downloaded).toBe(0);

    // Verify the note was uploaded — a fresh client should download it
    const client2 = await freshClient2();

    const summary2 = await client2.sync.syncNow();
    expect(summary2.downloaded).toBe(1);

    // Verify downloaded note content
    const content = await client2.notes.readNote('hello');
    expect(content).toBe('# Hello\nWorld');
  });

  it('download: upload via server API, sync down to client', async () => {
    // Upload a note directly through the server
    const token = await setupAndLogin(env.app);
    const content = '# Direct Upload\nVia API';
    const hashBytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(content)
    );
    const hash = Array.from(new Uint8Array(hashBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    await env.app.request('/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        notes: [
          {
            uuid: 'server-note-1',
            filename: 'direct-upload.md',
            modified_at: 1700000000000,
            content_hash: hash,
            hash_at_last_sync: '',
            content,
          },
        ],
        all_uuids: ['server-note-1'],
        deleted_uuids: [],
      }),
    });

    // Now sync client
    const client = await freshClient();
    await client.notes.initNotes();
    await client.prefs.loadPreferences();
    await client.syncState.clearSyncState();

    // Login (server already set up)
    await client.sync.connectSyncServer('http://localhost', 'testpassword123');
    const summary = await client.sync.syncNow();
    expect(summary.downloaded).toBe(1);

    // Verify note on disk
    const downloaded = await testFS.readNote('direct-upload');
    expect(downloaded).toBe(content);

    // Verify mtime was preserved from server's modified_at
    const files = await testFS.listNoteFiles();
    const file = files.find((f) => f.name === 'direct-upload.md');
    expect(file).toBeDefined();
    expect(Math.abs(file!.mtime - 1700000000000)).toBeLessThan(1000);
  });

  it('deletion propagation: sync up, delete locally, sync again', async () => {
    const client = await freshClient();
    await setupClient(client);

    // Create and sync a note
    await client.notes.createNote('deleteme', 'temporary content');
    await client.sync.syncNow();

    // Delete locally and sync again
    await client.notes.deleteNote('deleteme');
    const summary = await client.sync.syncNow();
    // The deleted UUID was sent to server
    expect(summary.deleted).toBe(0); // server confirms deletion, no extra deletes from server

    // A fresh client should NOT get the deleted note
    const client2 = await freshClient2();

    const summary2 = await client2.sync.syncNow();
    expect(summary2.downloaded).toBe(0);
    expect(client2.notes.getAllNotes()).toHaveLength(0);
  });

  it('deleteAllNotes propagates tombstones so notes do not reappear', async () => {
    const client = await freshClient();
    await setupClient(client);

    // Create several notes and sync
    await client.notes.createNote('note-a', 'content a');
    await client.notes.createNote('note-b', 'content b');
    await client.notes.createNote('note-c', 'content c');
    await client.sync.syncNow();
    expect(client.notes.getAllNotes()).toHaveLength(3);

    // Delete ALL notes and sync — tombstones must reach the server
    await client.notes.deleteAllNotes();
    expect(client.notes.getAllNotes()).toHaveLength(0);
    const summary = await client.sync.syncNow();
    // Server should not send any of the deleted notes back
    expect(summary.downloaded).toBe(0);

    // A fresh client should also see zero notes
    const client2 = await freshClient2();
    const summary2 = await client2.sync.syncNow();
    expect(summary2.downloaded).toBe(0);
    expect(client2.notes.getAllNotes()).toHaveLength(0);
  });

  it('two-client simulation: A syncs up, B syncs down', async () => {
    // Client A creates and syncs
    const clientA = await freshClient();
    await setupClient(clientA);
    await clientA.notes.createNote('shared-note', '# Shared\nFrom Client A');
    await clientA.sync.syncNow();

    // Client B starts fresh
    const clientB = await freshClient2();

    const summary = await clientB.sync.syncNow();
    expect(summary.downloaded).toBe(1);

    const content = await clientB.notes.readNote('shared-note');
    expect(content).toBe('# Shared\nFrom Client A');
  });
});

// ── Title-only rename tests ────────────────────────────────────────

describe('title-only rename sync', () => {
  it('rename via updateNote pushes new filename to server', async () => {
    const client = await freshClient();
    await setupClient(client);

    // Create and sync a note
    await client.notes.createNote('old-title', '# Some content');
    const s1 = await client.sync.syncNow();
    expect(s1.uploaded).toBe(1);

    // Rename (updateNote internally calls trackLocalRenameForSync)
    await client.notes.updateNote('new-title', 'new-title', '# Some content', 'old-title');

    // Sync — rename should be counted as uploaded
    const s2 = await client.sync.syncNow();
    expect(s2.uploaded).toBe(1);

    // A fresh client should get the note with the NEW title
    const client2 = await freshClient2();
    const s3 = await client2.sync.syncNow();
    expect(s3.downloaded).toBe(1);

    const notes = client2.notes.getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('new-title');
    expect(await client2.notes.readNote('new-title')).toBe('# Some content');
  });

  it('content hash is identical after rename (no spurious content change)', async () => {
    const client = await freshClient();
    await setupClient(client);

    const content = '# Stable content\nShould not change';
    await client.notes.createNote('note-a', content);
    await client.sync.syncNow();

    // Read synced state to get hash
    const state = await client.syncState.loadSyncState();
    const uuid = state.uuidById['note-a'];
    const hashBefore = state.hashByUuid[uuid];
    expect(hashBefore).toBeTruthy();

    // Rename, keeping content identical
    await client.notes.updateNote('note-b', 'note-b', content, 'note-a');

    // Read note back from disk to verify content survived the rename
    const afterRename = await client.notes.readNote('note-b');
    expect(afterRename).toBe(content);

    // Sync state should preserve the hash (uuid transferred)
    const stateAfter = await client.syncState.loadSyncState();
    expect(stateAfter.uuidById['note-b']).toBe(uuid);
    expect(stateAfter.uuidById['note-a']).toBeUndefined();
    expect(stateAfter.hashByUuid[uuid]).toBe(hashBefore);
  });

  it('multiple renames before sync all work correctly', async () => {
    const client = await freshClient();
    await setupClient(client);

    await client.notes.createNote('title-1', '# Content');
    await client.sync.syncNow();

    // Rapid renames (simulating slow typing with intermediate saves)
    await client.notes.updateNote('title-2', 'title-2', '# Content', 'title-1');
    await client.notes.updateNote('title-3', 'title-3', '# Content', 'title-2');
    await client.notes.updateNote('final-title', 'final-title', '# Content', 'title-3');

    // Sync should push the final rename
    const s = await client.sync.syncNow();
    expect(s.uploaded).toBe(1);

    // Fresh client gets the final title
    const client2 = await freshClient2();
    await client2.sync.syncNow();

    const notes = client2.notes.getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('final-title');
  });

  it('rename back to original name is a no-op on server', async () => {
    const client = await freshClient();
    await setupClient(client);

    await client.notes.createNote('original', '# Content');
    await client.sync.syncNow();

    // Rename away and back
    await client.notes.updateNote('temporary', 'temporary', '# Content', 'original');
    await client.notes.updateNote('original', 'original', '# Content', 'temporary');

    // Sync — server should see original filename (no change)
    const s = await client.sync.syncNow();
    // No rename on the server, so no hash_updates from rename
    expect(s.uploaded).toBe(0);

    // Fresh client gets the note with original title
    const client2 = await freshClient2();
    await client2.sync.syncNow();

    const notes = client2.notes.getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('original');
  });

  it('rename is idempotent: re-syncing after rename sends no further changes', async () => {
    const client = await freshClient();
    await setupClient(client);

    await client.notes.createNote('old', '# X');
    await client.sync.syncNow();

    await client.notes.updateNote('new', 'new', '# X', 'old');
    await client.sync.syncNow();

    // Second sync should have nothing to do
    const s = await client.sync.syncNow();
    expect(s.uploaded).toBe(0);
    expect(s.downloaded).toBe(0);
    expect(s.deleted).toBe(0);
    expect(s.conflicts).toBe(0);
  });

  it('rename + content change in same sync works', async () => {
    const client = await freshClient();
    await setupClient(client);

    await client.notes.createNote('old-name', '# Old content');
    await client.sync.syncNow();

    // Change both title and content
    await client.notes.updateNote('new-name', 'new-name', '# New content', 'old-name');
    const s = await client.sync.syncNow();
    expect(s.uploaded).toBe(1);

    // Verify on fresh client
    const client2 = await freshClient2();
    await client2.sync.syncNow();

    const notes = client2.notes.getAllNotes();
    expect(notes[0].id).toBe('new-name');
    expect(await client2.notes.readNote('new-name')).toBe('# New content');
  });

  it('rename of never-synced note: treated as new upload', async () => {
    const client = await freshClient();
    await setupClient(client);

    // Create note but do NOT sync
    await client.notes.createNote('unsaved', '# Draft');

    // Rename before first sync
    await client.notes.updateNote('saved-title', 'saved-title', '# Draft', 'unsaved');

    // First sync should upload the note under the final title
    const s = await client.sync.syncNow();
    expect(s.uploaded).toBe(1);

    // Fresh client gets it with the final title
    const client2 = await freshClient2();
    await client2.sync.syncNow();

    const notes = client2.notes.getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('saved-title');
  });

  it('sync state UUID mapping survives rename chain', async () => {
    const client = await freshClient();
    await setupClient(client);

    await client.notes.createNote('a', '# Content');
    await client.sync.syncNow();

    const state1 = await client.syncState.loadSyncState();
    const uuid = state1.uuidById['a'];
    expect(uuid).toBeTruthy();

    // Chain: a → b → c → d
    await client.notes.updateNote('b', 'b', '# Content', 'a');
    await client.notes.updateNote('c', 'c', '# Content', 'b');
    await client.notes.updateNote('d', 'd', '# Content', 'c');

    const state2 = await client.syncState.loadSyncState();
    expect(state2.uuidById['d']).toBe(uuid);
    expect(state2.uuidById['a']).toBeUndefined();
    expect(state2.uuidById['b']).toBeUndefined();
    expect(state2.uuidById['c']).toBeUndefined();
  });

  it('two clients: A renames, fresh B syncs down — sees new filename', async () => {
    // Client A creates, syncs, renames, syncs
    const clientA = await freshClient();
    await setupClient(clientA);
    await clientA.notes.createNote('shared', '# Shared note');
    await clientA.sync.syncNow();
    await clientA.notes.updateNote('renamed-shared', 'renamed-shared', '# Shared note', 'shared');
    await clientA.sync.syncNow();

    // Fresh Client B syncs — should get the note with the renamed title
    const clientB = await freshClient2();
    await clientB.sync.syncNow();

    const notes = clientB.notes.getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe('renamed-shared');
    expect(await clientB.notes.readNote('renamed-shared')).toBe('# Shared note');
  });
});

// ── Multi-FS contract tests (true two-client simulation) ──────────

describe('multi-client rename convergence', () => {
  let fsA: TestPlatformFS;
  let fsB: TestPlatformFS;

  beforeEach(() => {
    fsA = createNodeFS();
    fsB = createNodeFS();
  });

  afterEach(() => {
    fsA._cleanup();
    fsB._cleanup();
  });

  /**
   * Create a fresh client module set bound to a specific FS.
   * Unlike freshClient2(), does NOT destroy another client's state.
   */
  async function clientOnFS(fs: TestPlatformFS) {
    setActiveFS(fs);
    const client = await freshClient();
    await client.notes.initNotes();
    await client.prefs.loadPreferences();
    await client.syncState.clearSyncState();
    await client.sync.connectSyncServer('http://localhost', 'testpassword123');
    return client;
  }

  it('A renames, B (with stale name) syncs — converges without ping-pong', async () => {
    // Client A: create note and sync
    setActiveFS(fsA);
    const clientA = await clientOnFS(fsA);
    await clientA.notes.createNote('grocery list', '# Buy milk');
    const s1 = await clientA.sync.syncNow();
    expect(s1.uploaded).toBe(1);

    // Client B: sync to get the note
    const clientB = await clientOnFS(fsB);
    setActiveFS(fsB);
    const s2 = await clientB.sync.syncNow();
    expect(s2.downloaded).toBe(1);
    expect(await clientB.notes.readNote('grocery list')).toBe('# Buy milk');

    // Client A: rename (no content change) and sync
    setActiveFS(fsA);
    await clientA.notes.updateNote('shopping list', 'shopping list', '# Buy milk', 'grocery list');
    const s3 = await clientA.sync.syncNow();
    expect(s3.uploaded).toBe(1);

    // Client B: still has "grocery list" — sync should download the rename
    setActiveFS(fsB);
    const s4 = await clientB.sync.syncNow();
    expect(s4.downloaded).toBe(1);

    const bNotes = clientB.notes.getAllNotes();
    expect(bNotes).toHaveLength(1);
    expect(bNotes[0].id).toBe('shopping list');
    expect(await clientB.notes.readNote('shopping list')).toBe('# Buy milk');

    // Verify steady state: both clients sync with zero changes
    setActiveFS(fsA);
    const s5 = await clientA.sync.syncNow();
    expect(s5.uploaded).toBe(0);
    expect(s5.downloaded).toBe(0);

    setActiveFS(fsB);
    const s6 = await clientB.sync.syncNow();
    expect(s6.uploaded).toBe(0);
    expect(s6.downloaded).toBe(0);
  });
});
