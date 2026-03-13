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

// ── Phase 1: /sync/check and version tracking ────────────

describe('POST /sync/check', () => {
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
    const res = await req(env.app, 'POST', '/sync/check', { version: 0 });
    expect(res.status).toBe(401);
  });

  it('rejects missing version (422)', async () => {
    const res = await authReq(env.app, 'POST', '/sync/check', token, {});
    expect(res.status).toBe(422);
  });

  it('returns up_to_date when no mutations have occurred', async () => {
    const res = await authReq(env.app, 'POST', '/sync/check', token, { version: 0 });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('up_to_date');
    expect(data.version).toBe(0);
  });

  it('returns up_to_date after a no-op sync', async () => {
    // Empty sync — no mutations
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });

    const res = await authReq(env.app, 'POST', '/sync/check', token, { version: 0 });
    const data = await res.json();
    expect(data.status).toBe('up_to_date');
    expect(data.version).toBe(0);
  });

  it('returns changes_available after a note is uploaded', async () => {
    const content = 'hello';
    const hash = contentHash(content);

    // Upload a note — this mutates the server
    await authReq(env.app, 'POST', '/sync', token, {
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

    // Check with version 0 — should see changes
    const res = await authReq(env.app, 'POST', '/sync/check', token, { version: 0 });
    const data = await res.json();
    expect(data.status).toBe('changes_available');
    expect(data.version).toBeGreaterThan(0);
  });

  it('returns changes_available when the client version is ahead of the server', async () => {
    const res = await authReq(env.app, 'POST', '/sync/check', token, { version: 54 });
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string; version: number };
    expect(data.status).toBe('changes_available');
    expect(data.version).toBe(0);
  });

  it('returns up_to_date when client has current version', async () => {
    const content = 'hello';
    const hash = contentHash(content);

    // Upload a note
    const syncRes = await authReq(env.app, 'POST', '/sync', token, {
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
    const syncData = await syncRes.json();
    const version = syncData.version;
    expect(version).toBeGreaterThan(0);

    // Check with the current version — should be up to date
    const res = await authReq(env.app, 'POST', '/sync/check', token, { version });
    const data = await res.json();
    expect(data.status).toBe('up_to_date');
  });

  it('version increments on delete', async () => {
    const content = 'hello';
    const hash = contentHash(content);

    // Upload a note
    const syncRes = await authReq(env.app, 'POST', '/sync', token, {
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
    const v1 = (await syncRes.json()).version;

    // Delete the note
    const deleteRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: ['u1'],
    });
    const v2 = (await deleteRes.json()).version;
    expect(v2).toBeGreaterThan(v1);
  });
});

describe('/sync response includes version', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('includes version in sync response', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });
    const data = await res.json();
    expect(typeof data.version).toBe('number');
  });

  it('version increments only on mutations', async () => {
    // First empty sync — no mutation
    const res1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });
    const v1 = (await res1.json()).version;
    expect(v1).toBe(0);

    // Upload a note — mutation
    const content = 'hello';
    const hash = contentHash(content);
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
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
    const v2 = (await res2.json()).version;
    expect(v2).toBe(1);

    // Same note, no changes — no mutation
    const res3 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'test.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: hash,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const v3 = (await res3.json()).version;
    expect(v3).toBe(1);
  });
});

// ── Phase 3a: V2 sync format (inventory) ─────────────────

describe('V2 sync (inventory format)', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('handles empty V2 sync', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.update).toEqual([]);
    expect(data.delete).toEqual([]);
    expect(data.hash_updates).toEqual([]);
    expect(data.conflicts).toEqual([]);
    expect(typeof data.version).toBe('number');
  });

  it('uploads new note via V2', async () => {
    const content = '# New Note';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'new.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'new.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hash_updates).toEqual([{ uuid: 'u1', hash_at_last_sync: hash }]);
    expect(readNoteFile(env.notesDir, 'new.md')).toBe(content);
  });

  it('detects server-side changes for inventory-only entries', async () => {
    const content = 'original';
    const hash = contentHash(content);

    // Upload via V1
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'doc.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Another client modifies via V1
    const newContent = 'modified by B';
    const newHash = contentHash(newContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'doc.md',
          modified_at: Date.now(),
          content_hash: newHash,
          hash_at_last_sync: hash,
          content: newContent,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Original client syncs V2 — note is unchanged on client (inventory only)
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'doc.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    const data = await res.json();
    expect(data.update).toHaveLength(1);
    expect(data.update[0].uuid).toBe('u1');
    expect(data.update[0].content).toBe(newContent);
    expect(data.update[0].content_hash).toBe(newHash);
  });

  it('skips unchanged inventory entries', async () => {
    const content = 'stable';
    const hash = contentHash(content);

    // Upload
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'stable.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // V2 sync with matching hash — no update expected
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'stable.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    const data = await res.json();
    expect(data.update).toEqual([]);
    expect(data.hash_updates).toEqual([]);
  });

  it('sends server-only notes to V2 client', async () => {
    const content = 'server only';
    const hash = contentHash(content);

    // Upload from another client via V1
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'server-only.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // New client syncs V2 with empty inventory — should get the note
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });

    const data = await res.json();
    expect(data.update).toHaveLength(1);
    expect(data.update[0].uuid).toBe('u1');
    expect(data.update[0].content).toBe(content);
  });

  it('handles V2 deletions', async () => {
    const content = 'to delete';
    const hash = contentHash(content);

    // Upload
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'delete-me.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Delete via V2
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: ['u1'],
    });

    await res.json();
    expect(readNoteFile(env.notesDir, 'delete-me.md')).toBeNull();
  });

  it('rejects V2 with malformed inventory', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [{ uuid: 'u1' }], // missing content_hash and filename
      deleted_uuids: [],
    });
    expect(res.status).toBe(422);
  });
});

// ── Sync optimization edge cases ──────────────────────────

describe('sync optimization edge cases', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('version is monotonically increasing across multiple operations', async () => {
    const contentA = '# Note A';
    const hashA = contentHash(contentA);

    // Upload note A
    const uploadRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note-a.md',
          modified_at: Date.now(),
          content_hash: hashA,
          hash_at_last_sync: '',
          content: contentA,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const v1 = (await uploadRes.json()).version;
    expect(v1).toBeGreaterThan(0);

    // Modify note A
    const modifiedContent = '# Note A (modified)';
    const modifiedHash = contentHash(modifiedContent);
    const modifyRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note-a.md',
          modified_at: Date.now(),
          content_hash: modifiedHash,
          hash_at_last_sync: hashA,
          content: modifiedContent,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const v2 = (await modifyRes.json()).version;
    expect(v2).toBeGreaterThan(v1);

    // Delete note A
    const deleteRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: [],
      deleted_uuids: ['u1'],
    });
    const v3 = (await deleteRes.json()).version;
    expect(v3).toBeGreaterThan(v2);

    // All versions strictly increasing
    expect(v1 < v2 && v2 < v3).toBe(true);
  });

  it('V2 conflict produces correct version bump', async () => {
    const origContent = 'original content';
    const origHash = contentHash(origContent);

    // Client A uploads a note via V1
    const uploadRes = await authReq(env.app, 'POST', '/sync', token, {
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
    const vAfterUpload = (await uploadRes.json()).version;

    // Client B modifies the note via V1 (server now has different content)
    const bContent = 'modified by client B';
    const bHash = contentHash(bContent);
    const bRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'shared.md',
          modified_at: Date.now(),
          content_hash: bHash,
          hash_at_last_sync: origHash,
          content: bContent,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const vAfterB = (await bRes.json()).version;
    expect(vAfterB).toBeGreaterThan(vAfterUpload);

    // Client A sends stale V2 sync — it changed content too but has stale hash_at_last_sync
    const aContent = 'modified by client A';
    const aHash = contentHash(aContent);
    const conflictRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'shared.md',
          modified_at: Date.now(),
          content_hash: aHash,
          hash_at_last_sync: origHash, // stale — server has bHash now
          content: aContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: aHash, filename: 'shared.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    const conflictData = await conflictRes.json();
    const vAfterConflict = conflictData.version;

    // Version should have incremented (conflict creates a new note)
    expect(vAfterConflict).toBeGreaterThan(vAfterB);

    // Server sends its version of u1 back to client A, plus the conflict copy as a new note
    const u1Update = conflictData.update.find((u: { uuid: string }) => u.uuid === 'u1');
    expect(u1Update).toBeDefined();
    expect(u1Update.content).toBe(bContent);

    // The conflict copy (new UUID) is also sent as an update
    const conflictCopyUpdate = conflictData.update.find((u: { uuid: string }) => u.uuid !== 'u1');
    expect(conflictCopyUpdate).toBeDefined();
    expect(conflictCopyUpdate.content).toBe(aContent);

    // Conflict info is populated
    expect(conflictData.conflicts).toHaveLength(1);
    expect(conflictData.conflicts[0].uuid).toBe('u1');
    expect(conflictData.conflicts[0].client_content).toBe(aContent);
  });

  it('V2 rename detection via inventory', async () => {
    const content = 'rename me';
    const hash = contentHash(content);

    // Upload via V1
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'old-name.md',
          modified_at: 1000,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Verify file exists on server
    expect(readNoteFile(env.notesDir, 'old-name.md')).toBe(content);

    // V2 sync with inventory-only: different filename, matching hash, newer modified_at
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'new-name.md', modified_at: 2000 }],
      deleted_uuids: [],
    });

    const data = await res.json();

    // Server should rename the file and return hash_updates
    expect(data.hash_updates).toHaveLength(1);
    expect(data.hash_updates[0].uuid).toBe('u1');

    // New file should exist, old file should be gone
    expect(readNoteFile(env.notesDir, 'new-name.md')).toBe(content);
    expect(readNoteFile(env.notesDir, 'old-name.md')).toBeNull();
  });

  it('V2 rename from server wins when server is newer', async () => {
    const content = 'rename me';
    const hash = contentHash(content);

    // Upload via V1 with old filename
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'original.md',
          modified_at: 1000,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Another client renames via V1 (newer modified_at, same content)
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'server-renamed.md',
          modified_at: 3000,
          content_hash: hash,
          hash_at_last_sync: hash,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Verify the server has the renamed file
    expect(readNoteFile(env.notesDir, 'server-renamed.md')).toBe(content);

    // Original client sends V2 inventory-only with old filename and older modified_at
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'original.md', modified_at: 1000 }],
      deleted_uuids: [],
    });

    const data = await res.json();

    // Server should send its renamed version back
    expect(data.update).toHaveLength(1);
    expect(data.update[0].uuid).toBe('u1');
    expect(data.update[0].filename).toBe('server-renamed.md');
    expect(data.update[0].content).toBe(content);
  });

  it('sync/check returns up_to_date at exactly the current version', async () => {
    const content = 'check me';
    const hash = contentHash(content);

    // Upload a note to bump the version
    const syncRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'check.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const currentVersion = (await syncRes.json()).version;
    expect(currentVersion).toBeGreaterThan(0);

    // Check at exactly the current version → up_to_date
    const exactRes = await authReq(env.app, 'POST', '/sync/check', token, { version: currentVersion });
    const exactData = await exactRes.json();
    expect(exactData.status).toBe('up_to_date');

    // Check at version - 1 → changes_available
    const staleRes = await authReq(env.app, 'POST', '/sync/check', token, { version: currentVersion - 1 });
    const staleData = await staleRes.json();
    expect(staleData.status).toBe('changes_available');
  });

  it('no-op V1 and V2 syncs do not increment version', async () => {
    const content = 'stable note';
    const hash = contentHash(content);

    // Upload a note to establish a baseline version
    const setupRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'u1',
          filename: 'stable.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const baseVersion = (await setupRes.json()).version;
    expect(baseVersion).toBeGreaterThan(0);

    // V1 empty sync — no mutations
    const v1EmptyRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });
    const v1EmptyVersion = (await v1EmptyRes.json()).version;
    expect(v1EmptyVersion).toBe(baseVersion);

    // V2 empty sync — no mutations
    const v2EmptyRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    const v2EmptyVersion = (await v2EmptyRes.json()).version;
    expect(v2EmptyVersion).toBe(baseVersion);

    // V2 sync with inventory item that matches server — no mutations
    const v2MatchRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'stable.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });
    const v2MatchVersion = (await v2MatchRes.json()).version;
    expect(v2MatchVersion).toBe(baseVersion);
  });
});
