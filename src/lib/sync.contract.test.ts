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

import { testFS } from '$lib/platform';

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
    testFS._reset();
    const client2 = await freshClient();
    await client2.notes.initNotes();
    await client2.prefs.loadPreferences();

    // Set up client2 with same server credentials (login, not setup)
    await client2.sync.connectSyncServer('http://localhost', 'testpassword123');

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
    testFS._reset();
    const client2 = await freshClient();
    await client2.notes.initNotes();
    await client2.prefs.loadPreferences();
    await client2.syncState.clearSyncState();
    await client2.sync.connectSyncServer('http://localhost', 'testpassword123');

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
    testFS._reset();
    const clientB = await freshClient();
    await clientB.notes.initNotes();
    await clientB.prefs.loadPreferences();
    await clientB.syncState.clearSyncState();
    await clientB.sync.connectSyncServer('http://localhost', 'testpassword123');

    const summary = await clientB.sync.syncNow();
    expect(summary.downloaded).toBe(1);

    const content = await clientB.notes.readNote('shared-note');
    expect(content).toBe('# Shared\nFrom Client A');
  });
});
