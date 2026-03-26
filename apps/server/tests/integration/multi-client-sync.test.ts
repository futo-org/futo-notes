import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, type TestEnv } from '../helpers/setup.js';
import { SyncClient } from '../helpers/sync-client.js';
import { contentHash } from '../../src/sync/hash.js';

// ── Tests ───────────────────────────────────────────────

describe('Multi-client sync', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('full convergence with state tracking', async () => {
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // A creates note, syncs
    const uuid = clientA.createNote('groceries.md', '# Groceries\n- milk');
    const resA1 = await clientA.sync();

    // A should get hash_updates confirming the note
    expect(resA1.hash_updates).toHaveLength(1);
    expect(resA1.hash_updates[0].uuid).toBe(uuid);
    expect(clientA.hashByUuid.has(uuid)).toBe(true);
    expect(clientA.uuidByFilename.get('groceries.md')).toBe(uuid);

    // B syncs — gets the note
    const resB1 = await clientB.sync();
    expect(resB1.update).toHaveLength(1);
    expect(resB1.update[0].uuid).toBe(uuid);
    expect(clientB.notes.has(uuid)).toBe(true);
    expect(clientB.hashByUuid.has(uuid)).toBe(true);
    expect(clientB.uuidByFilename.get('groceries.md')).toBe(uuid);

    // B edits note, syncs
    clientB.editNote(uuid, '# Groceries\n- milk\n- bread');
    const resB2 = await clientB.sync();
    expect(resB2.hash_updates).toHaveLength(1);

    // Both clients should have the same hash for the uuid now
    const bHash = clientB.hashByUuid.get(uuid);
    expect(bHash).toBe(contentHash('# Groceries\n- milk\n- bread'));

    // A syncs — gets B's edit
    const resA2 = await clientA.sync();
    expect(resA2.update).toHaveLength(1);
    expect(resA2.update[0].uuid).toBe(uuid);
    expect(resA2.update[0].content).toBe('# Groceries\n- milk\n- bread');

    // Both clients now have same state
    expect(clientA.hashByUuid.get(uuid)).toBe(clientB.hashByUuid.get(uuid));
    expect(clientA.getNote(uuid)!.content).toBe(clientB.getNote(uuid)!.content);
    expect(clientA.uuidByFilename.get('groceries.md')).toBe(uuid);
    expect(clientB.uuidByFilename.get('groceries.md')).toBe(uuid);

    // Both at same server version
    expect(clientA.serverVersion).toBe(clientB.serverVersion);
  });

  it('delete vs edit race — delete wins', async () => {
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // A creates note, syncs
    const uuid = clientA.createNote('ephemeral.md', 'original content');
    await clientA.sync();

    // B syncs — gets the note
    await clientB.sync();
    expect(clientB.notes.has(uuid)).toBe(true);

    // A deletes the note, syncs
    clientA.deleteNote(uuid);
    await clientA.sync();
    // Deletion should be processed (no update for this uuid)
    expect(clientA.notes.has(uuid)).toBe(false);

    // B edits the note offline, then syncs
    clientB.editNote(uuid, 'edited by B after A deleted');
    const resB = await clientB.sync();

    // B should get delete instruction — delete wins
    expect(resB.delete).toContain(uuid);
    expect(clientB.notes.has(uuid)).toBe(false);
    expect(clientB.hashByUuid.has(uuid)).toBe(false);

    // Verify both clients converge — neither has the note
    expect(clientA.notes.size).toBe(0);
    expect(clientB.notes.size).toBe(0);
  });

  it('delete then recreate with same filename', async () => {
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // A creates "foo.md" (uuid-1), syncs
    const uuid1 = clientA.createNote('foo.md', 'version 1');
    await clientA.sync();

    // B syncs — gets foo.md
    await clientB.sync();
    expect(clientB.notes.has(uuid1)).toBe(true);

    // A deletes "foo.md", syncs
    clientA.deleteNote(uuid1);
    await clientA.sync();
    expect(clientA.notes.has(uuid1)).toBe(false);

    // A creates new "foo.md" (uuid-2), syncs
    const uuid2 = clientA.createNote('foo.md', 'version 2');
    await clientA.sync();
    expect(uuid2).not.toBe(uuid1);
    expect(clientA.notes.has(uuid2)).toBe(true);

    // B syncs: should get delete for uuid-1 and update for uuid-2
    const resB = await clientB.sync();
    expect(resB.delete).toContain(uuid1);

    // B should now have uuid-2 but not uuid-1
    expect(clientB.notes.has(uuid1)).toBe(false);
    expect(clientB.notes.has(uuid2)).toBe(true);
    expect(clientB.getNote(uuid2)!.content).toBe('version 2');

    // Both clients converge on same state
    expect(clientA.notes.size).toBe(1);
    expect(clientB.notes.size).toBe(1);
    expect(clientA.getNote(uuid2)!.content).toBe(clientB.getNote(uuid2)!.content);
  });

  it('rename collision — server deduplicates', async () => {
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // A creates "alpha.md", syncs
    const uuid1 = clientA.createNote('alpha.md', 'note one');
    await clientA.sync();

    // B creates "beta.md", syncs
    const uuid2 = clientB.createNote('beta.md', 'note two');
    await clientB.sync();

    // Both sync to get each other's notes
    await clientA.sync();
    await clientB.sync();

    // A renames note-1 to "shared.md", syncs
    clientA.renameNote(uuid1, 'shared.md');
    await clientA.sync();

    // B renames note-2 to "shared.md", syncs
    // Server already has uuid1 as "shared.md", so uuid2 gets deduplicated
    clientB.renameNote(uuid2, 'shared.md');
    await clientB.sync();

    // Multiple sync rounds to allow convergence — the server deduplicates
    // the second rename, and clients need rounds to learn the final filenames
    for (let i = 0; i < 3; i++) {
      await clientA.sync();
      await clientB.sync();
    }

    // Both notes should still exist on both clients
    const aNote1 = clientA.getNote(uuid1);
    const aNote2 = clientA.getNote(uuid2);
    const bNote1 = clientB.getNote(uuid1);
    const bNote2 = clientB.getNote(uuid2);

    expect(aNote1).toBeDefined();
    expect(aNote2).toBeDefined();
    expect(bNote1).toBeDefined();
    expect(bNote2).toBeDefined();

    // Content preserved regardless of rename outcome
    expect(aNote1!.content).toBe('note one');
    expect(aNote2!.content).toBe('note two');
    expect(bNote1!.content).toBe('note one');
    expect(bNote2!.content).toBe('note two');

    // One note should have "shared.md", the other a deduplicated name
    // (the exact dedup naming is server-internal, but filenames must differ)
    const serverFilenames = new Set([aNote1!.filename, aNote2!.filename]);
    expect(serverFilenames.size).toBe(2);
    expect(serverFilenames.has('shared.md')).toBe(true);
  });

  it('100 notes in one batch', async () => {
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // A creates 100 notes
    const uuids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const uuid = clientA.createNote(`note-${i.toString().padStart(3, '0')}.md`, `Content of note ${i}`);
      uuids.push(uuid);
    }

    // A syncs all 100
    const resA = await clientA.sync();
    expect(resA.hash_updates).toHaveLength(100);

    // B syncs — should get all 100
    const resB = await clientB.sync();
    expect(resB.update).toHaveLength(100);

    // Verify count and content
    expect(clientB.notes.size).toBe(100);
    for (let i = 0; i < 100; i++) {
      const note = clientB.getNote(uuids[i]);
      expect(note).toBeDefined();
      expect(note!.content).toBe(`Content of note ${i}`);
    }
  });

  it('incremental after large sync — only changed note returned', async () => {
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // A creates 100 notes, syncs
    const uuids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const uuid = clientA.createNote(`bulk-${i.toString().padStart(3, '0')}.md`, `Bulk content ${i}`);
      uuids.push(uuid);
    }
    await clientA.sync();

    // B syncs — gets all 100 (baseline)
    await clientB.sync();
    expect(clientB.notes.size).toBe(100);

    // A edits 1 note
    clientA.editNote(uuids[42], 'Updated content for note 42');
    await clientA.sync();

    // B syncs — should get exactly 1 update
    const resB = await clientB.sync();
    expect(resB.update).toHaveLength(1);
    expect(resB.update[0].uuid).toBe(uuids[42]);
    expect(resB.update[0].content).toBe('Updated content for note 42');

    // B still has all 100 notes
    expect(clientB.notes.size).toBe(100);
  });

  it('concurrent sync requests — all notes present, no duplicates', async () => {
    // Create 5 independent clients, each with 1 unique note
    const clients: SyncClient[] = [];
    const expectedUuids: string[] = [];

    for (let i = 0; i < 5; i++) {
      const client = new SyncClient(env.app, token);
      const uuid = client.createNote(`concurrent-${i}.md`, `Concurrent note ${i}`);
      clients.push(client);
      expectedUuids.push(uuid);
    }

    // Fire all 5 sync requests simultaneously
    const results = await Promise.all(clients.map((c) => c.sync()));

    // All should succeed (200 response = valid SyncResponse)
    for (const result of results) {
      expect(result.version).toBeGreaterThan(0);
    }

    // Now sync a fresh client and verify all 5 notes present
    const verifier = new SyncClient(env.app, token);
    const verifyRes = await verifier.sync();

    expect(verifyRes.update.length).toBe(5);
    expect(verifier.notes.size).toBe(5);

    // All 5 UUIDs should be present
    for (const uuid of expectedUuids) {
      expect(verifier.notes.has(uuid)).toBe(true);
    }

    // No duplicate filenames
    const filenames = new Set<string>();
    for (const [, note] of verifier.notes) {
      expect(filenames.has(note.filename)).toBe(false);
      filenames.add(note.filename);
    }
    expect(filenames.size).toBe(5);
  });

  // ── Reset-client dedup tests ──────────────────────────────

  it('reset client with same notes does not create duplicates', async () => {
    // Client A syncs 20 notes to fresh server
    const clientA = new SyncClient(env.app, token);
    for (let i = 0; i < 20; i++) {
      clientA.createNote(`note-${i}.md`, `Content for note ${i}`);
    }
    await clientA.sync();

    // Client B has the exact same 20 files but with fresh UUIDs (simulating reset)
    const clientB = new SyncClient(env.app, token);
    for (let i = 0; i < 20; i++) {
      clientB.createNote(`note-${i}.md`, `Content for note ${i}`);
    }
    const resB = await clientB.sync();

    // Client B should NOT create duplicates. All its UUIDs should be tombstoned
    // and it should receive the server's 20 notes via delete + update.
    expect(resB.delete.length).toBe(20); // all client B UUIDs tombstoned

    // Verify with a fresh client: exactly 20 notes, no (2) duplicates
    const verifier = new SyncClient(env.app, token);
    await verifier.sync();
    expect(verifier.notes.size).toBe(20);

    const filenames = [...verifier.notes.values()].map((n) => n.filename);
    expect(filenames.filter((f) => f.includes('(2)')).length).toBe(0);
  });

  it('reset client with slightly different content: server wins, no (2) copies', async () => {
    // Client A syncs 10 notes
    const clientA = new SyncClient(env.app, token);
    for (let i = 0; i < 10; i++) {
      clientA.createNote(`doc-${i}.md`, `Original content ${i}`);
    }
    await clientA.sync();

    // Client B has same filenames but 5 have slightly different content (fresh UUIDs)
    const clientB = new SyncClient(env.app, token);
    for (let i = 0; i < 10; i++) {
      const content = i < 5 ? `Original content ${i}` : `Modified content ${i}`;
      clientB.createNote(`doc-${i}.md`, content);
    }
    const resB = await clientB.sync();

    // All 10 client B UUIDs should be tombstoned (reset client, server wins)
    expect(resB.delete.length).toBe(10);

    // Verify: exactly 10 notes, server content preserved for all
    const verifier = new SyncClient(env.app, token);
    await verifier.sync();
    expect(verifier.notes.size).toBe(10);

    // Server's original content should be preserved (not client B's modified content)
    for (let i = 5; i < 10; i++) {
      const note = verifier.getNoteByFilename(`doc-${i}.md`);
      expect(note).toBeDefined();
      expect(note!.content).toBe(`Original content ${i}`);
    }

    // No (2) duplicates
    const filenames = [...verifier.notes.values()].map((n) => n.filename);
    expect(filenames.filter((f) => f.includes('(2)')).length).toBe(0);
  });

  it('client with real sync history creating colliding filename gets (2) copy', async () => {
    // Client A creates and syncs a note
    const clientA = new SyncClient(env.app, token);
    clientA.createNote('shared-name.md', 'Client A original');
    await clientA.sync();

    // Client B syncs to get the note (establishing sync history)
    const clientB = new SyncClient(env.app, token);
    await clientB.sync();
    expect(clientB.notes.size).toBe(1);

    // Client B creates a NEW note with the same filename (has sync history → hash_at_last_sync is set for existing)
    // But this new note has empty hash_at_last_sync because it's never been synced.
    // However, the client has sync history overall (serverVersion > 0, hashByUuid populated).
    // The key difference: when a client has previously synced, it already has the existing note's UUID.
    // A truly new note with a colliding name from a synced client is a legitimate collision.
    clientB.createNote('new-note.md', 'Client B new note');
    await clientB.sync();

    // Client A syncs and creates another note with the same filename as B's new note
    clientA.createNote('new-note.md', 'Client A different note');
    await clientA.sync();

    // This should create a (2) copy since Client A has real sync history
    const verifier = new SyncClient(env.app, token);
    await verifier.sync();

    const filenames = [...verifier.notes.values()].map((n) => n.filename).sort();
    expect(filenames).toContain('new-note.md');
    expect(filenames.some((f) => f.startsWith('new-note') && f.includes('(2)'))).toBe(true);
  });
});
