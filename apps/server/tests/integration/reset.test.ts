import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { createTestEnv, setupAndLogin, authReq, req, type TestEnv } from '../helpers/setup.js';
import { contentHash } from '../../src/sync/hash.js';
import { readNoteFile } from '../../src/sync/files.js';
import { SCHEMA_VERSION, createTables, migrateSchema } from '../../src/db/schema.js';

describe('POST /reset', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('rejects unauthorized request (401)', async () => {
    const res = await req(env.app, 'POST', '/reset', { confirmation: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('rejects incorrect confirmation (400)', async () => {
    const res = await authReq(env.app, 'POST', '/reset', token, { confirmation: 'delete' });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('Confirmation mismatch');
  });

  it('wipes notes, clears setup, and revokes all sessions', async () => {
    const content = '# Reset me';
    const hash = contentHash(content);

    // Seed one note.
    const upload = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u-reset',
          filename: 'reset-me.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: [{ uuid: 'u-reset', content_hash: hash, filename: 'reset-me.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });
    expect(upload.status).toBe(200);
    expect(readNoteFile(env.notesDir, 'reset-me.md')).toBe(content);

    // Create a second logged-in session.
    const loginRes = await req(env.app, 'POST', '/login', { password: 'testpassword123' });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json() as { token: string };
    const secondToken = loginData.token;

    // Perform reset.
    const resetRes = await authReq(env.app, 'POST', '/reset', token, { confirmation: 'DELETE' });
    expect(resetRes.status).toBe(200);
    const resetData = await resetRes.json() as {
      success: boolean;
      notes_deleted: number;
      sessions_revoked: number;
      setup_cleared: boolean;
    };
    expect(resetData.success).toBe(true);
    expect(resetData.notes_deleted).toBe(1);
    expect(resetData.sessions_revoked).toBe(2);
    expect(resetData.setup_cleared).toBe(true);

    // Dashboard status requires auth now; verify reset via /health.
    const healthRes = await req(env.app, 'GET', '/health');
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json() as { setup_complete: boolean };
    expect(health.setup_complete).toBe(false);

    // Unauthenticated /dashboard/status should return 401 after reset.
    const statusRes = await req(env.app, 'GET', '/dashboard/status');
    expect(statusRes.status).toBe(401);

    // All sessions should be invalid.
    const syncWithFirst = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(syncWithFirst.status).toBe(401);

    const syncWithSecond = await authReq(env.app, 'POST', '/sync', secondToken, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(syncWithSecond.status).toBe(401);

    // Notes directory should be recreated empty.
    expect(readNoteFile(env.notesDir, 'reset-me.md')).toBeNull();
    const diskEntries = fs.readdirSync(env.notesDir);
    expect(diskEntries).toEqual([]);

    // Old password should be gone until setup is run again.
    const postResetLogin = await req(env.app, 'POST', '/login', { password: 'testpassword123' });
    expect(postResetLogin.status).toBe(403);

    const setupAgain = await req(env.app, 'POST', '/setup', { password: 'newpassword123' });
    expect(setupAgain.status).toBe(201);
  });

  it('sync with blobs works after reset (regression: is_blob column missing)', async () => {
    const content = '# Before reset';
    const hash = contentHash(content);

    // Seed a note before reset.
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [{ uuid: 'u-pre', filename: 'pre.md', modified_at: Date.now(), content_hash: hash, hash_at_last_sync: '', content }],
      inventory: [{ uuid: 'u-pre', content_hash: hash, filename: 'pre.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    // Reset.
    const resetRes = await authReq(env.app, 'POST', '/reset', token, { confirmation: 'DELETE' });
    expect(resetRes.status).toBe(200);

    // Re-setup and login.
    await req(env.app, 'POST', '/setup', { password: 'newpass123' });
    const loginRes = await req(env.app, 'POST', '/login', { password: 'newpass123' });
    const newToken = ((await loginRes.json()) as { token: string }).token;

    // Sync a blob note — this used to fail with "table notes has no column named is_blob".
    const blobContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const blobHash = contentHash(blobContent);
    const syncRes = await authReq(env.app, 'POST', '/sync', newToken, {
      notes: [{ uuid: 'u-blob', filename: 'image.png', modified_at: Date.now(), content_hash: blobHash, hash_at_last_sync: '', content: blobContent, is_blob: true }],
      inventory: [{ uuid: 'u-blob', content_hash: blobHash, filename: 'image.png', modified_at: Date.now() }],
      deleted_uuids: [],
    });
    expect(syncRes.status).toBe(200);
  });

  it('reset DB has correct schema version and matches fresh DB', async () => {
    // Perform reset.
    const resetRes = await authReq(env.app, 'POST', '/reset', token, { confirmation: 'DELETE' });
    expect(resetRes.status).toBe(200);

    // Open the reset DB directly and check user_version.
    const resetDb = new Database(env.dbPath);
    const resetVersion = resetDb.pragma('user_version', { simple: true }) as number;
    expect(resetVersion).toBe(SCHEMA_VERSION);

    // Compare table_info for core tables with a fresh DB.
    const freshDb = new Database(':memory:');
    createTables(freshDb);
    migrateSchema(freshDb);

    const coreTables = ['auth', 'sessions', 'notes', 'tombstones', 'sync_meta', 'note_tags'];
    for (const table of coreTables) {
      const resetColumns = resetDb.pragma(`table_info(${table})`);
      const freshColumns = freshDb.pragma(`table_info(${table})`);
      expect(resetColumns).toEqual(freshColumns);
    }

    resetDb.close();
    freshDb.close();
  });

  it('dev nuke uses the same full reset behavior without auth', async () => {
    const content = '# Reset me too';
    const hash = contentHash(content);

    const upload = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u-dev-reset',
          filename: 'dev-reset-me.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: [{ uuid: 'u-dev-reset', content_hash: hash, filename: 'dev-reset-me.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });
    expect(upload.status).toBe(200);
    expect(readNoteFile(env.notesDir, 'dev-reset-me.md')).toBe(content);

    const loginRes = await req(env.app, 'POST', '/login', { password: 'testpassword123' });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json() as { token: string };
    const secondToken = loginData.token;

    const nukeRes = await req(env.app, 'POST', '/dev/nuke', { confirmation: 'DELETE' });
    expect(nukeRes.status).toBe(200);
    const nukeData = await nukeRes.json() as {
      success: boolean;
      notes_deleted: number;
      sessions_revoked: number;
      setup_cleared: boolean;
      message: string;
    };
    expect(nukeData.success).toBe(true);
    expect(nukeData.notes_deleted).toBe(1);
    expect(nukeData.sessions_revoked).toBe(2);
    expect(nukeData.setup_cleared).toBe(true);
    expect(nukeData.message).toContain('Server wiped clean');

    // Dashboard status requires auth; verify reset via /health.
    const healthRes2 = await req(env.app, 'GET', '/health');
    expect(healthRes2.status).toBe(200);
    const health2 = await healthRes2.json() as { setup_complete: boolean };
    expect(health2.setup_complete).toBe(false);

    // Unauthenticated /dashboard/status should return 401 after nuke.
    const statusRes = await req(env.app, 'GET', '/dashboard/status');
    expect(statusRes.status).toBe(401);

    const syncWithFirst = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(syncWithFirst.status).toBe(401);

    const syncWithSecond = await authReq(env.app, 'POST', '/sync', secondToken, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(syncWithSecond.status).toBe(401);

    expect(readNoteFile(env.notesDir, 'dev-reset-me.md')).toBeNull();
    const diskEntries = fs.readdirSync(env.notesDir);
    expect(diskEntries).toEqual([]);

    const postResetLogin = await req(env.app, 'POST', '/login', { password: 'testpassword123' });
    expect(postResetLogin.status).toBe(403);
  });
});
