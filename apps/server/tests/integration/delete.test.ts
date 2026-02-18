import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, authReq, type TestEnv } from '../helpers/setup.js';
import { contentHash } from '../../src/sync/hash.js';
import { readNoteFile } from '../../src/sync/files.js';

describe('delete propagation', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('client delete removes file and propagates via tombstone', async () => {
    const content = 'to be deleted';
    const hash = contentHash(content);

    // Upload a note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'deleteme.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    expect(readNoteFile(env.notesDir, 'deleteme.md')).toBe(content);

    // Client A deletes the note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: ['u1'],
    });
    expect(readNoteFile(env.notesDir, 'deleteme.md')).toBeNull();

    // Client B still has the note — should be told to delete
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const data = await res.json();
    expect(data.delete).toContain('u1');
  });

  it('re-upload of tombstoned note returns delete instruction', async () => {
    const content = 'revived';
    const hash = contentHash(content);

    // Upload and delete
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: ['u1'],
    });

    // Another client tries to re-upload the same UUID
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const data = await res.json();
    expect(data.delete).toContain('u1');
  });
});
