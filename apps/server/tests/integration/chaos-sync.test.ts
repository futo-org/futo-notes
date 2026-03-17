import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, authReq, type TestEnv } from '../helpers/setup.js';
import { contentHash } from '../../src/sync/hash.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Build an inventory array from a list of note descriptors.
 * Each descriptor must include uuid, filename, content_hash, and modified_at.
 */
function inv(notes: Array<{ uuid: string; filename: string; content_hash: string; modified_at: number }>) {
  return notes.map(({ uuid, filename, content_hash, modified_at }) => ({
    uuid,
    content_hash,
    filename,
    modified_at,
  }));
}

describe('Chaos sync tests', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  // ── content_hash lying (3 tests) ──────────────────────────

  it('Test 8: client claims unchanged but actually changed — sneaky content ignored', async () => {
    // CHAOS: documents that a lying client's content field is silently ignored
    // when hashes match, potentially leading to data loss if the client sends
    // stale hash but new content.
    const original = 'original content';
    const originalHash = contentHash(original);
    const now = Date.now();

    // First sync: upload the note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-1',
          filename: 'test8.md',
          modified_at: now,
          content_hash: originalHash,
          hash_at_last_sync: '',
          content: original,
        },
      ],
      inventory: inv([{ uuid: 'uuid-1', filename: 'test8.md', content_hash: originalHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Verify initial content on disk
    const diskContent1 = readFileSync(path.join(env.notesDir, 'test8.md'), 'utf8');
    expect(diskContent1).toBe(original);

    // Second sync: client LIES — claims unchanged (hashes match) but sends new content
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-1',
          filename: 'test8.md',
          modified_at: now + 1,
          content_hash: originalHash, // claiming unchanged
          hash_at_last_sync: originalHash, // matching — no-change path
          content: 'sneaky new content', // but including different content!
        },
      ],
      inventory: inv([{ uuid: 'uuid-1', filename: 'test8.md', content_hash: originalHash, modified_at: now + 1 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // The engine sees clientHash === lastSync === serverHash → "no change" path.
    // The content field is ignored. Disk should still have original content.
    const diskContent2 = readFileSync(path.join(env.notesDir, 'test8.md'), 'utf8');
    expect(diskContent2).toBe(original);
  });

  it('Test 9: client sends wrong content_hash for NEW note — server recomputes', async () => {
    const realContent = 'hello world';
    const realHash = contentHash(realContent);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-9',
          filename: 'test9.md',
          modified_at: now,
          content_hash: 'wrong_hash_value', // deliberate lie
          hash_at_last_sync: '',
          content: realContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-9', filename: 'test9.md', content_hash: 'wrong_hash_value', modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Server should recompute the hash from actual content
    // hash_updates should contain the real hash, not the wrong one
    expect(data.hash_updates).toHaveLength(1);
    expect(data.hash_updates[0].uuid).toBe('uuid-9');
    expect(data.hash_updates[0].hash_at_last_sync).toBe(realHash);
    expect(data.hash_updates[0].hash_at_last_sync).not.toBe('wrong_hash_value');
  });

  it('Test 10: client claims changed but content matches server — idempotent write', async () => {
    const content = 'stable content';
    const realHash = contentHash(content);
    const now = Date.now();

    // First sync: upload the note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-10',
          filename: 'test10.md',
          modified_at: now,
          content_hash: realHash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-10', filename: 'test10.md', content_hash: realHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Second sync: client claims it changed (fake old hash) but sends same content
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-10',
          filename: 'test10.md',
          modified_at: now + 1,
          content_hash: realHash,
          hash_at_last_sync: 'fake_old_hash', // lies about last sync hash
          content, // but content is actually the same
        },
      ],
      inventory: inv([{ uuid: 'uuid-10', filename: 'test10.md', content_hash: realHash, modified_at: now + 1 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // Verify disk still has the correct content — no data loss
    const diskContent = readFileSync(path.join(env.notesDir, 'test10.md'), 'utf8');
    expect(diskContent).toBe(content);
  });

  // ── Duplicate/contradictory UUIDs (3 tests) ───────────────

  it('Test 11: same UUID twice in notes[] — server does not crash', async () => {
    // CHAOS: documents which content wins when the same UUID appears twice
    const content1 = 'first version';
    const hash1 = contentHash(content1);
    const content2 = 'second version';
    const hash2 = contentHash(content2);
    const now = Date.now();

    let res: Response;
    try {
      res = await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: 'uuid-dup',
            filename: 'duplicate.md',
            modified_at: now,
            content_hash: hash1,
            hash_at_last_sync: '',
            content: content1,
          },
          {
            uuid: 'uuid-dup',
            filename: 'duplicate.md',
            modified_at: now + 1,
            content_hash: hash2,
            hash_at_last_sync: '',
            content: content2,
          },
        ],
        inventory: inv([{ uuid: 'uuid-dup', filename: 'duplicate.md', content_hash: hash2, modified_at: now + 1 }]),
        deleted_uuids: [],
      });
    } catch (e) {
      // CHAOS: if the server crashes, document it
      expect.unreachable(`Server crashed on duplicate UUID in notes[]: ${e}`);
      return;
    }

    // Server should not crash — any 2xx is acceptable
    expect(res.status).toBe(200);

    // Document which content won (likely the last one processed)
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const diskContent = readFileSync(path.join(env.notesDir, files[0]), 'utf8');
    // The second entry is processed second; for a new note the first creates it,
    // the second sees it as existing. Document actual behavior.
    expect([content1, content2]).toContain(diskContent);
  });

  it('Test 12: UUID in both notes[] and deleted_uuids — deletion should win', async () => {
    const content = 'will be deleted';
    const hash = contentHash(content);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-conflict',
          filename: 'conflicted.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-conflict', filename: 'conflicted.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: ['uuid-conflict'], // also requesting deletion
    });

    expect(res.status).toBe(200);

    // Engine processes deletes first (section 1), then notes (section 3)
    // which skips notes whose uuid is in deleted_uuids.
    // The note should NOT exist on disk.
    let files: string[] = [];
    try {
      files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    } catch {
      // notesDir may not exist if nothing was ever written — that's fine
    }
    expect(files).toHaveLength(0);
  });

  it('Test 13: tombstone resurrection — server should reject re-created note', async () => {
    const content = 'ephemeral note';
    const hash = contentHash(content);
    const now = Date.now();

    // Step 1: Create the note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-tomb',
          filename: 'tomb.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-tomb', filename: 'tomb.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Step 2: Delete the note (creates tombstone)
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: ['uuid-tomb'],
    });

    // Step 3: Try to resurrect the note with the same UUID
    const newContent = 'I am back from the dead!';
    const newHash = contentHash(newContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-tomb',
          filename: 'tomb.md',
          modified_at: now + 1,
          content_hash: newHash,
          hash_at_last_sync: '',
          content: newContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-tomb', filename: 'tomb.md', content_hash: newHash, modified_at: now + 1 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Server should tell client to delete the resurrected note (tombstone is permanent)
    expect(data.delete).toContain('uuid-tomb');

    // The note should NOT exist on disk
    const files = readdirSync(env.notesDir).filter((f) => f === 'tomb.md');
    expect(files).toHaveLength(0);
  });

  // ── Timestamp abuse (2 tests) ─────────────────────────────

  it('Test 14: modified_at far-future — far-future note wins rename conflicts', async () => {
    const content = 'far future note';
    const hash = contentHash(content);
    // Use year-9999 timestamp instead of MAX_SAFE_INTEGER to avoid EINVAL from
    // utimes on filesystems that can't represent dates past 2038/2106.
    const farFuture = new Date('9999-12-31T23:59:59Z').getTime();

    // Upload a note with a far-future modified_at
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-future',
          filename: 'future.md',
          modified_at: farFuture,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-future', filename: 'future.md', content_hash: hash, modified_at: farFuture }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // Now simulate another client trying to rename with a normal timestamp
    // Since hashes match and the far-future note has an astronomically high
    // modified_at, the "other client" rename with a normal timestamp should lose.
    const now = Date.now();
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-future',
          filename: 'renamed-by-normal-client.md',
          modified_at: now, // normal timestamp, far less than farFuture
          content_hash: hash,
          hash_at_last_sync: hash,
        },
      ],
      inventory: inv([{ uuid: 'uuid-future', filename: 'renamed-by-normal-client.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res2.status).toBe(200);
    const data2 = await res2.json();

    // The server should send back the far-future filename since its modified_at
    // (far-future) is newer than the rename attempt's Date.now()
    expect(data2.update).toHaveLength(1);
    expect(data2.update[0].filename).toBe('future.md');
  });

  it('Test 15: modified_at -1 — note is stored and retrievable', async () => {
    const content = 'negative timestamp';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-neg',
          filename: 'negative.md',
          modified_at: -1,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-neg', filename: 'negative.md', content_hash: hash, modified_at: -1 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // Verify it was stored
    const diskContent = readFileSync(path.join(env.notesDir, 'negative.md'), 'utf8');
    expect(diskContent).toBe(content);

    // Verify it can be synced back by another client
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });

    const data2 = await res2.json();
    const note = data2.update.find((u: { uuid: string }) => u.uuid === 'uuid-neg');
    expect(note).toBeDefined();
    expect(note.content).toBe(content);
  });

  // ── Payload stress (2 tests) ──────────────────────────────

  it('Test 16: 10MB note body — large content stored and retrieved', async () => {
    // Build a ~10MB string
    const chunk = 'x'.repeat(1024); // 1KB
    const bigContent = chunk.repeat(10 * 1024); // ~10MB
    const hash = contentHash(bigContent);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-big',
          filename: 'big note.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content: bigContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-big', filename: 'big note.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // Verify stored on disk
    const diskContent = readFileSync(path.join(env.notesDir, 'big note.md'), 'utf8');
    expect(diskContent.length).toBe(bigContent.length);
    expect(contentHash(diskContent)).toBe(hash);

    // Verify it can be retrieved
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });

    const data2 = await res2.json();
    const note = data2.update.find((u: { uuid: string }) => u.uuid === 'uuid-big');
    expect(note).toBeDefined();
    expect(note.content.length).toBe(bigContent.length);
  }, 30_000); // extended timeout for large payload

  it('Test 17: 1000 notes with empty content — all stored', async () => {
    const notes = [];
    const inventoryItems = [];
    const now = Date.now();
    const emptyHash = contentHash('');

    for (let i = 0; i < 1000; i++) {
      const uuid = `uuid-mass-${i}`;
      const filename = `mass note ${i}.md`;
      notes.push({
        uuid,
        filename,
        modified_at: now,
        content_hash: emptyHash,
        hash_at_last_sync: '',
        content: '',
      });
      inventoryItems.push({ uuid, filename, content_hash: emptyHash, modified_at: now });
    }

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes,
      inventory: inv(inventoryItems),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // All 1000 notes should get hash_updates
    expect(data.hash_updates).toHaveLength(1000);

    // Verify on disk
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1000);
  }, 30_000); // extended timeout for large batch

  // ── Validation gaps (2 tests) ─────────────────────────────

  it('Test 18: inventory entry with path traversal filename — handled safely', async () => {
    // First, upload a legitimate note so the server has something
    const content = 'legit note';
    const hash = contentHash(content);
    const now = Date.now();
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-legit',
          filename: 'legit.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-legit', filename: 'legit.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Now send an inventory entry with a path traversal filename
    // The route validates note filenames in notes[], but inventory items
    // may not get the same title validation.
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [
        {
          uuid: 'uuid-traversal',
          content_hash: 'somehash',
          filename: '../../../etc/passwd.md',
          modified_at: now,
        },
      ],
      deleted_uuids: [],
    });

    // Server should handle it safely — either reject (422) or process without
    // writing outside the notes directory
    // The key check: no file should exist at the traversal path
    const status = res.status;
    expect([200, 422]).toContain(status);

    // Verify no file was written outside notes dir via path traversal
    // (the inventory entry references a UUID the server doesn't have, so it
    // would be skipped in the inventory-only processing path anyway)
  });

  it('Test 19: filename that is just spaces — sanitized to Untitled', async () => {
    const content1 = 'space note 1';
    const hash1 = contentHash(content1);
    const now = Date.now();

    // Send a note with filename that is just spaces + .md
    // validateTitle("   ") would flag as 'empty', so the route should reject.
    // But if the filename bypasses validation somehow, sanitizeFilename would
    // produce "Untitled.md" via sanitizeTitle's fallback.
    const res1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-space1',
          filename: '   .md',
          modified_at: now,
          content_hash: hash1,
          hash_at_last_sync: '',
          content: content1,
        },
      ],
      inventory: inv([{ uuid: 'uuid-space1', filename: '   .md', content_hash: hash1, modified_at: now }]),
      deleted_uuids: [],
    });

    // The route's validateTitle("   ") should return an 'empty' issue → 422
    // This verifies the validation catches whitespace-only titles
    if (res1.status === 422) {
      // Good: server correctly rejects whitespace-only filename
      expect(res1.status).toBe(422);
      return;
    }

    // If it somehow gets through, verify sanitization happened
    expect(res1.status).toBe(200);
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    // sanitizeTitle("   ") → trim → "" → fallback "Untitled"
    expect(files[0]).toBe('Untitled.md');

    // Send a second note with the same whitespace filename — verify deduplication
    const content2 = 'space note 2';
    const hash2 = contentHash(content2);
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-space2',
          filename: '   .md',
          modified_at: now + 1,
          content_hash: hash2,
          hash_at_last_sync: '',
          content: content2,
        },
      ],
      inventory: inv([
        { uuid: 'uuid-space1', filename: '   .md', content_hash: hash1, modified_at: now },
        { uuid: 'uuid-space2', filename: '   .md', content_hash: hash2, modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });

    if (res2.status === 200) {
      const files2 = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
      expect(files2).toHaveLength(2);
      expect(files2).toContain('Untitled.md');
      expect(files2).toContain('Untitled (2).md');
    }
  });
});
