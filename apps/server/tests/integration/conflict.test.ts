import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, authReq, type TestEnv } from '../helpers/setup.js';
import { contentHash } from '../../src/sync/hash.js';
import { readNoteFile } from '../../src/sync/files.js';

describe('conflict detection and resolution', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('creates conflict copy when both sides change', async () => {
    const origContent = 'original';
    const origHash = contentHash(origContent);

    // Client A uploads
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'shared.md',
          modified_at: Date.now(),
          content_hash: origHash,
          hash_at_last_sync: '',
          content: origContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: origHash, filename: 'shared.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    // Simulate server-side change (e.g., from client B syncing first)
    const serverContent = 'server version';
    const serverHash = contentHash(serverContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'shared.md',
          modified_at: Date.now(),
          content_hash: serverHash,
          hash_at_last_sync: origHash,
          content: serverContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: serverHash, filename: 'shared.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    // Client A (stale) syncs with its own changes
    const clientContent = 'client A version';
    const clientHash = contentHash(clientContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'shared.md',
          modified_at: Date.now(),
          content_hash: clientHash,
          hash_at_last_sync: origHash,
          content: clientContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: clientHash, filename: 'shared.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    const data = await res.json();

    // Server sends its version to client A + conflict copy as new note
    expect(data.update).toHaveLength(2);
    const origUpdate = data.update.find((u: any) => u.uuid === 'u1');
    expect(origUpdate?.content).toBe(serverContent);

    // Conflict copy sent as a new server-only note
    const conflictUpdate = data.update.find((u: any) => u.uuid !== 'u1');
    expect(conflictUpdate?.content).toBe(clientContent);

    // Conflict metadata reported
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0].client_content).toBe(clientContent);

    // Conflict file should exist on disk with client content
    const conflictFile = data.conflicts[0].client_filename;
    expect(readNoteFile(env.notesDir, conflictFile)).toBe(clientContent);

    // Original file should still have server content
    expect(readNoteFile(env.notesDir, 'shared.md')).toBe(serverContent);
  });

  it('conflict filename is deterministic with date', async () => {
    const origContent = 'original';
    const origHash = contentHash(origContent);

    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'doc.md',
          modified_at: Date.now(),
          content_hash: origHash,
          hash_at_last_sync: '',
          content: origContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: origHash, filename: 'doc.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    // Server change
    const sContent = 'server';
    const sHash = contentHash(sContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'doc.md',
          modified_at: Date.now(),
          content_hash: sHash,
          hash_at_last_sync: origHash,
          content: sContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: sHash, filename: 'doc.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    // Stale client
    const cContent = 'client';
    const cHash = contentHash(cContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'doc.md',
          modified_at: Date.now(),
          content_hash: cHash,
          hash_at_last_sync: origHash,
          content: cContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: cHash, filename: 'doc.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    const data = await res.json();
    const dateStr = new Date().toISOString().split('T')[0];
    expect(data.conflicts[0].client_filename).toBe(`doc (conflict ${dateStr}).md`);
  });
});
