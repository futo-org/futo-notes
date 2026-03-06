import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, authReq, req, type TestEnv } from '../helpers/setup.js';
import { contentHash } from '../../src/sync/hash.js';
import { readNoteFile } from '../../src/sync/files.js';

describe('POST /sync', () => {
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
    const res = await req(env.app, 'POST', '/sync', {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid payload (422)', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, { notes: 'bad' });
    expect(res.status).toBe(422);
  });

  it('handles empty sync', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.update).toEqual([]);
    expect(data.delete).toEqual([]);
    expect(data.hash_updates).toEqual([]);
    expect(data.conflicts).toEqual([]);
  });

  it('full round-trip: upload then download', async () => {
    const content = '# Test Note\nHello!';
    const hash = contentHash(content);

    // Client A uploads a note
    const uploadRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'test.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    expect(uploadRes.status).toBe(200);
    const uploadData = await uploadRes.json();
    expect(uploadData.hash_updates).toEqual([{ uuid: 'u1', hash_at_last_sync: hash }]);

    // Client B has no notes — should receive the note
    const downloadRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });
    expect(downloadRes.status).toBe(200);
    const downloadData = await downloadRes.json();
    expect(downloadData.update).toHaveLength(1);
    expect(downloadData.update[0].uuid).toBe('u1');
    expect(downloadData.update[0].content).toBe(content);
  });

  it('two-client modification scenario', async () => {
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
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Client A modifies the note
    const newContent = 'modified by A';
    const newHash = contentHash(newContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'shared.md',
          modified_at: Date.now(),
          content_hash: newHash,
          hash_at_last_sync: origHash,
          content: newContent,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hash_updates).toEqual([{ uuid: 'u1', hash_at_last_sync: newHash }]);
    expect(readNoteFile(env.notesDir, 'shared.md')).toBe(newContent);
  });

  it('rejects invalid JSON (400)', async () => {
    const res = await env.app.request('/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects note missing required fields (422)', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [{ uuid: 'u1' }],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    expect(res.status).toBe(422);
  });

  it('rejects note filenames that do not map to valid titles (422)', async () => {
    const content = 'bad title';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: '.hidden.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    expect(res.status).toBe(422);
  });
});
