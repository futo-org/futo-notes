import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createTestEnv, setupAndLogin, authReq, req, type TestEnv } from '../helpers/setup.js';
import { contentHash } from '../../src/sync/hash.js';
import { readNoteFile } from '../../src/sync/files.js';

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
      all_uuids: ['u-reset'],
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

    // Dashboard status should reflect a fresh setup state.
    const statusRes = await req(env.app, 'GET', '/dashboard/status');
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json() as {
      notes_count: number;
      sessions_count: number;
      setup_complete: boolean;
    };
    expect(status.notes_count).toBe(0);
    expect(status.sessions_count).toBe(0);
    expect(status.setup_complete).toBe(false);

    // All sessions should be invalid.
    const syncWithFirst = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });
    expect(syncWithFirst.status).toBe(401);

    const syncWithSecond = await authReq(env.app, 'POST', '/sync', secondToken, {
      notes: [],
      all_uuids: [],
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
});
