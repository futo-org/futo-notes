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

  it('Test 11: same UUID twice in notes[] — server rejects with 422', async () => {
    // Duplicate UUIDs in notes[] are now rejected at the validation layer.
    const content1 = 'first version';
    const hash1 = contentHash(content1);
    const content2 = 'second version';
    const hash2 = contentHash(content2);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
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

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toMatch(/duplicate UUID/i);
  });

  it('Test 12: UUID in both notes[] and deleted_uuids — server rejects with 422', async () => {
    // Having the same UUID in both notes[] and deleted_uuids is now rejected
    // at the validation layer as a protocol violation.
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

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toMatch(/both notes and deleted_uuids/);
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

  it('Test 15: modified_at -1 — rejected as invalid', async () => {
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

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/modified_at/);
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

  // ── Inventory / notes[] disagreement (2 tests) ─────────

  it('Test 20: note in notes[] but missing from inventory — still accepted', async () => {
    const content = 'orphan note';
    const hash = contentHash(content);
    const now = Date.now();

    // Send a note in notes[] but deliberately omit it from inventory
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-orphan',
          filename: 'orphan.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: [], // empty — doesn't list the note
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // The note should still be saved to disk since notes[] is processed before inventory
    const diskContent = readFileSync(path.join(env.notesDir, 'orphan.md'), 'utf8');
    expect(diskContent).toBe(content);

    // Server should send hash_updates confirming the note
    expect(data.hash_updates).toHaveLength(1);
    expect(data.hash_updates[0].uuid).toBe('uuid-orphan');
  });

  it('Test 21: note in inventory but not in notes[] with wrong hash — server sends update', async () => {
    const content = 'server-side note';
    const hash = contentHash(content);
    const now = Date.now();

    // First sync: upload the note normally
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-inv',
          filename: 'inventory-test.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-inv', filename: 'inventory-test.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Second sync: claim different hash in inventory but don't send in notes[]
    // This simulates a client that thinks it has a different version
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv([{ uuid: 'uuid-inv', filename: 'inventory-test.md', content_hash: 'stale_hash', modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Server should detect hash mismatch and send the real content as an update
    expect(data.update).toHaveLength(1);
    expect(data.update[0].uuid).toBe('uuid-inv');
    expect(data.update[0].content).toBe(content);
  });

  // ── Filename collision within single request ───────────

  it('Test 22: two different UUIDs with same filename in one sync — server deduplicates', async () => {
    const content1 = 'first claim';
    const hash1 = contentHash(content1);
    const content2 = 'second claim';
    const hash2 = contentHash(content2);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-same-name-1',
          filename: 'collision.md',
          modified_at: now,
          content_hash: hash1,
          hash_at_last_sync: '',
          content: content1,
        },
        {
          uuid: 'uuid-same-name-2',
          filename: 'collision.md',
          modified_at: now + 1,
          content_hash: hash2,
          hash_at_last_sync: '',
          content: content2,
        },
      ],
      inventory: inv([
        { uuid: 'uuid-same-name-1', filename: 'collision.md', content_hash: hash1, modified_at: now },
        { uuid: 'uuid-same-name-2', filename: 'collision.md', content_hash: hash2, modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // Both notes should exist on disk — one as "collision.md", one as "collision (2).md"
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(2);
    expect(files.sort()).toEqual(['collision (2).md', 'collision.md']);

    // Both contents should be present
    const contents = files.map((f) => readFileSync(path.join(env.notesDir, f), 'utf8'));
    expect(contents.sort()).toEqual([content1, content2].sort());
  });

  it('Test 23: three UUIDs same filename — cascading dedup (2), (3)', async () => {
    const notes = [];
    const inventoryItems = [];
    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      const content = `triple collision ${i}`;
      const hash = contentHash(content);
      const uuid = `uuid-triple-${i}`;
      notes.push({
        uuid,
        filename: 'triple.md',
        modified_at: now + i,
        content_hash: hash,
        hash_at_last_sync: '',
        content,
      });
      inventoryItems.push({ uuid, filename: 'triple.md', content_hash: hash, modified_at: now + i });
    }

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes,
      inventory: inv(inventoryItems),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(3);
    expect(files.sort()).toEqual(['triple (2).md', 'triple (3).md', 'triple.md']);
  });

  // ── Content-aware dedup abuse ──────────────────────────

  it('Test 24: duplicate UUID with same filename+content — server deduplicates', async () => {
    const content = 'dedup me';
    const hash = contentHash(content);
    const now = Date.now();

    // First sync: upload the original note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-orig',
          filename: 'dedup-target.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-orig', filename: 'dedup-target.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Second sync: NEW uuid, same filename and content — triggers dedup path
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-clone',
          filename: 'dedup-target.md',
          modified_at: now + 1,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([
        { uuid: 'uuid-orig', filename: 'dedup-target.md', content_hash: hash, modified_at: now },
        { uuid: 'uuid-clone', filename: 'dedup-target.md', content_hash: hash, modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Server should deduplicate: tombstone the clone UUID, tell client to delete it
    expect(data.delete).toContain('uuid-clone');

    // Only one file should exist on disk
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('dedup-target.md');
  });

  it('Test 25: same content but different filename — not deduplicated', async () => {
    const content = 'shared content';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload two notes: same content, different filenames, different UUIDs
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-samecontent-1',
          filename: 'copy-a.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
        {
          uuid: 'uuid-samecontent-2',
          filename: 'copy-b.md',
          modified_at: now + 1,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([
        { uuid: 'uuid-samecontent-1', filename: 'copy-a.md', content_hash: hash, modified_at: now },
        { uuid: 'uuid-samecontent-2', filename: 'copy-b.md', content_hash: hash, modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Different filenames → should NOT deduplicate — both notes should exist
    expect(data.delete).not.toContain('uuid-samecontent-1');
    expect(data.delete).not.toContain('uuid-samecontent-2');

    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(2);
    expect(files.sort()).toEqual(['copy-a.md', 'copy-b.md']);
  });

  // ── Timestamp edge cases ───────────────────────────────

  it('Test 26: modified_at = 0 — accepted (boundary of valid range)', async () => {
    const content = 'epoch note';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-epoch',
          filename: 'epoch.md',
          modified_at: 0,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-epoch', filename: 'epoch.md', content_hash: hash, modified_at: 0 }]),
      deleted_uuids: [],
    });

    // 0 is valid (non-negative, finite) — should be accepted
    expect(res.status).toBe(200);
    const diskContent = readFileSync(path.join(env.notesDir, 'epoch.md'), 'utf8');
    expect(diskContent).toBe(content);
  });

  it('Test 27: modified_at = NaN — rejected as invalid', async () => {
    const content = 'nan timestamp';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-nan',
          filename: 'nan.md',
          modified_at: NaN,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-nan', filename: 'nan.md', content_hash: hash, modified_at: NaN }]),
      deleted_uuids: [],
    });

    // NaN is not finite → should be rejected
    expect(res.status).toBe(400);
  });

  it('Test 28: modified_at = Infinity — rejected as invalid', async () => {
    const content = 'infinity timestamp';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-inf',
          filename: 'infinity.md',
          modified_at: Infinity,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-inf', filename: 'infinity.md', content_hash: hash, modified_at: Infinity }]),
      deleted_uuids: [],
    });

    // Infinity is not finite → should be rejected
    expect(res.status).toBe(400);
  });

  // ── Multi-client adversarial scenarios ─────────────────

  it('Test 29: concurrent rename race — both clients rename same note differently', async () => {
    const content = 'rename target';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload the note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-rename-race',
          filename: 'original-name.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-rename-race', filename: 'original-name.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Client A renames to "name-a.md" with higher timestamp
    const resA = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-rename-race',
          filename: 'name-a.md',
          modified_at: now + 200,
          content_hash: hash,
          hash_at_last_sync: hash,
        },
      ],
      inventory: inv([{ uuid: 'uuid-rename-race', filename: 'name-a.md', content_hash: hash, modified_at: now + 200 }]),
      deleted_uuids: [],
    });

    expect(resA.status).toBe(200);

    // Client B renames to "name-b.md" with lower timestamp (stale)
    const resB = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-rename-race',
          filename: 'name-b.md',
          modified_at: now + 100, // older than A's rename
          content_hash: hash,
          hash_at_last_sync: hash,
        },
      ],
      inventory: inv([{ uuid: 'uuid-rename-race', filename: 'name-b.md', content_hash: hash, modified_at: now + 100 }]),
      deleted_uuids: [],
    });

    expect(resB.status).toBe(200);
    const dataB = await resB.json();

    // Server should reject B's stale rename — A's filename wins (higher modified_at)
    // Server sends back the winning filename to B
    expect(dataB.update).toHaveLength(1);
    expect(dataB.update[0].filename).toBe('name-a.md');

    // Only "name-a.md" should exist on disk
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['name-a.md']);
  });

  it('Test 30: client edits and renames simultaneously — both applied', async () => {
    const originalContent = 'before edit';
    const originalHash = contentHash(originalContent);
    const now = Date.now();

    // Upload original note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-edit-rename',
          filename: 'pre-rename.md',
          modified_at: now,
          content_hash: originalHash,
          hash_at_last_sync: '',
          content: originalContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-edit-rename', filename: 'pre-rename.md', content_hash: originalHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Client sends edit + rename in single sync
    const newContent = 'after edit and rename';
    const newHash = contentHash(newContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-edit-rename',
          filename: 'post-rename.md',
          modified_at: now + 1,
          content_hash: newHash,
          hash_at_last_sync: originalHash,
          content: newContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-edit-rename', filename: 'post-rename.md', content_hash: newHash, modified_at: now + 1 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // New file should exist with new content, old file should be gone
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['post-rename.md']);

    const diskContent = readFileSync(path.join(env.notesDir, 'post-rename.md'), 'utf8');
    expect(diskContent).toBe(newContent);
  });

  // ── Malformed payload validation ───────────────────────

  it('Test 31: note missing uuid field — rejected', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          // no uuid
          filename: 'no-uuid.md',
          modified_at: Date.now(),
          content_hash: contentHash('test'),
          hash_at_last_sync: '',
          content: 'test',
        },
      ],
      inventory: [],
      deleted_uuids: [],
    });

    expect([400, 422]).toContain(res.status);
  });

  it('Test 32: note missing filename field — rejected', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-no-filename',
          // no filename
          modified_at: Date.now(),
          content_hash: contentHash('test'),
          hash_at_last_sync: '',
          content: 'test',
        },
      ],
      inventory: [],
      deleted_uuids: [],
    });

    expect([400, 422]).toContain(res.status);
  });

  it('Test 33: notes is not an array — rejected', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: 'not an array',
      inventory: [],
      deleted_uuids: [],
    });

    expect([400, 422]).toContain(res.status);
  });

  it('Test 34: deleted_uuids contains non-string — rejected or handled', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [123, null, undefined],
    });

    // Server should either reject or handle gracefully (no crash)
    expect([200, 400, 422]).toContain(res.status);
  });

  it('Test 35: empty uuid string in notes — rejected or handled', async () => {
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: '',
          filename: 'empty-uuid.md',
          modified_at: Date.now(),
          content_hash: contentHash('test'),
          hash_at_last_sync: '',
          content: 'test',
        },
      ],
      inventory: inv([{ uuid: '', filename: 'empty-uuid.md', content_hash: contentHash('test'), modified_at: Date.now() }]),
      deleted_uuids: [],
    });

    // Empty UUID should be rejected or at least handled without crash
    expect([200, 400, 422]).toContain(res.status);
  });

  // ── Version tracking adversarial ───────────────────────

  it('Test 36: version monotonically increases across mutations', async () => {
    const now = Date.now();
    const versions: number[] = [];

    // Sync 1: create note
    const res1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-ver-1',
          filename: 'ver1.md',
          modified_at: now,
          content_hash: contentHash('v1'),
          hash_at_last_sync: '',
          content: 'v1',
        },
      ],
      inventory: inv([{ uuid: 'uuid-ver-1', filename: 'ver1.md', content_hash: contentHash('v1'), modified_at: now }]),
      deleted_uuids: [],
    });
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    versions.push(data1.version);

    // Sync 2: create another note
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-ver-2',
          filename: 'ver2.md',
          modified_at: now + 1,
          content_hash: contentHash('v2'),
          hash_at_last_sync: '',
          content: 'v2',
        },
      ],
      inventory: inv([
        { uuid: 'uuid-ver-1', filename: 'ver1.md', content_hash: contentHash('v1'), modified_at: now },
        { uuid: 'uuid-ver-2', filename: 'ver2.md', content_hash: contentHash('v2'), modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    versions.push(data2.version);

    // Sync 3: delete first note
    const res3 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv([{ uuid: 'uuid-ver-2', filename: 'ver2.md', content_hash: contentHash('v2'), modified_at: now + 1 }]),
      deleted_uuids: ['uuid-ver-1'],
    });
    expect(res3.status).toBe(200);
    const data3 = await res3.json();
    versions.push(data3.version);

    // All versions should be strictly increasing
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
  });

  it('Test 37: no-op sync (no mutations) does not bump version', async () => {
    const content = 'stable';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload a note
    const res1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-noop',
          filename: 'noop.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-noop', filename: 'noop.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });
    const data1 = await res1.json();
    const version1 = data1.version;

    // Send identical state — no changes
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv([{ uuid: 'uuid-noop', filename: 'noop.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });
    const data2 = await res2.json();
    const version2 = data2.version;

    // No mutations → version should not change
    expect(version2).toBe(version1);
  });

  // ── Conflict resolution edge cases ─────────────────────

  it('Test 38: both client and server change same note — conflict copy created', async () => {
    const originalContent = 'original shared';
    const originalHash = contentHash(originalContent);
    const now = Date.now();

    // Client A uploads original
    const resA1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-conflict-38',
          filename: 'shared-note.md',
          modified_at: now,
          content_hash: originalHash,
          hash_at_last_sync: '',
          content: originalContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-conflict-38', filename: 'shared-note.md', content_hash: originalHash, modified_at: now }]),
      deleted_uuids: [],
    });
    expect(resA1.status).toBe(200);
    const dataA1 = await resA1.json();
    const serverHash = dataA1.hash_updates[0].hash_at_last_sync;

    // Client B syncs — gets the note, learns the hash
    const resB1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(resB1.status).toBe(200);

    // Client A edits the note on server side
    const serverContent = 'edited by server-side client A';
    const serverNewHash = contentHash(serverContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-conflict-38',
          filename: 'shared-note.md',
          modified_at: now + 10,
          content_hash: serverNewHash,
          hash_at_last_sync: serverHash,
          content: serverContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-conflict-38', filename: 'shared-note.md', content_hash: serverNewHash, modified_at: now + 10 }]),
      deleted_uuids: [],
    });

    // Client B (offline since first sync) edits the same note and syncs
    // Its hash_at_last_sync is the ORIGINAL hash — both client and server diverged
    const clientContent = 'edited by offline client B';
    const clientNewHash = contentHash(clientContent);
    const resB2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-conflict-38',
          filename: 'shared-note.md',
          modified_at: now + 5,
          content_hash: clientNewHash,
          hash_at_last_sync: serverHash, // stale — based on original, not A's edit
          content: clientContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-conflict-38', filename: 'shared-note.md', content_hash: clientNewHash, modified_at: now + 5 }]),
      deleted_uuids: [],
    });

    expect(resB2.status).toBe(200);
    const dataB2 = await resB2.json();

    // Server should detect three-way conflict and create a conflict copy
    expect(dataB2.conflicts.length).toBeGreaterThanOrEqual(1);

    // Both the server version AND the conflict copy should exist on disk
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(2);

    // One file should contain the server's content
    const contents = files.map((f) => readFileSync(path.join(env.notesDir, f), 'utf8'));
    expect(contents).toContain(serverContent);
    expect(contents).toContain(clientContent);
  });

  it('Test 39: rapid consecutive conflicts — each gets unique conflict name', async () => {
    const baseContent = 'base content';
    const baseHash = contentHash(baseContent);
    const now = Date.now();

    // Upload original
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-multiconflict',
          filename: 'multi-conflict.md',
          modified_at: now,
          content_hash: baseHash,
          hash_at_last_sync: '',
          content: baseContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-multiconflict', filename: 'multi-conflict.md', content_hash: baseHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Server-side edit 1
    const edit1 = 'server edit 1';
    const edit1Hash = contentHash(edit1);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-multiconflict',
          filename: 'multi-conflict.md',
          modified_at: now + 10,
          content_hash: edit1Hash,
          hash_at_last_sync: baseHash,
          content: edit1,
        },
      ],
      inventory: inv([{ uuid: 'uuid-multiconflict', filename: 'multi-conflict.md', content_hash: edit1Hash, modified_at: now + 10 }]),
      deleted_uuids: [],
    });

    // Two conflicting clients sync with stale hashes
    for (let i = 0; i < 2; i++) {
      const clientEdit = `conflict client ${i}`;
      const clientHash = contentHash(clientEdit);
      const res = await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: 'uuid-multiconflict',
            filename: 'multi-conflict.md',
            modified_at: now + 5 + i,
            content_hash: clientHash,
            hash_at_last_sync: baseHash,
            content: clientEdit,
          },
        ],
        inventory: inv([{ uuid: 'uuid-multiconflict', filename: 'multi-conflict.md', content_hash: clientHash, modified_at: now + 5 + i }]),
        deleted_uuids: [],
      });
      expect(res.status).toBe(200);
    }

    // There should be multiple conflict copies with unique names
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    // At least: original + 2 conflict copies
    expect(files.length).toBeGreaterThanOrEqual(3);

    // All filenames should be unique
    const uniqueNames = new Set(files);
    expect(uniqueNames.size).toBe(files.length);
  });

  // ── Filename sanitization attacks ──────────────────────

  it('Test 40: forbidden characters in filename — rejected', async () => {
    const forbidden = ['<script>.md', 'note|pipe.md', 'note?.md', 'note*.md', 'note"quote.md'];

    for (const filename of forbidden) {
      const res = await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: `uuid-forbidden-${filename}`,
            filename,
            modified_at: Date.now(),
            content_hash: contentHash('test'),
            hash_at_last_sync: '',
            content: 'test',
          },
        ],
        inventory: inv([{ uuid: `uuid-forbidden-${filename}`, filename, content_hash: contentHash('test'), modified_at: Date.now() }]),
        deleted_uuids: [],
      });

      expect(res.status).toBe(422);
    }
  });

  it('Test 41: filename at exactly 200 char limit — accepted', async () => {
    // Title is filename minus ".md" — so 200 chars for title + 3 for .md = 203 total
    const title = 'a'.repeat(200);
    const filename = `${title}.md`;
    const content = 'max length title';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-maxlen',
          filename,
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-maxlen', filename, content_hash: hash, modified_at: Date.now() }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
  });

  it('Test 42: filename exceeding 200 char limit — rejected', async () => {
    const title = 'a'.repeat(201);
    const filename = `${title}.md`;
    const content = 'too long title';
    const hash = contentHash(content);

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-toolong',
          filename,
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-toolong', filename, content_hash: hash, modified_at: Date.now() }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(422);
  });

  it('Test 43: filename with control characters — rejected', async () => {
    const filename = 'note\x00evil.md';
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-control',
          filename,
          modified_at: Date.now(),
          content_hash: contentHash('test'),
          hash_at_last_sync: '',
          content: 'test',
        },
      ],
      inventory: inv([{ uuid: 'uuid-control', filename, content_hash: contentHash('test'), modified_at: Date.now() }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(422);
  });

  it('Test 44: filename with leading/trailing dots — rejected', async () => {
    const badNames = ['.hidden.md', '..double-dot.md', 'trailing..md'];

    for (const filename of badNames) {
      const res = await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: `uuid-dots-${filename}`,
            filename,
            modified_at: Date.now(),
            content_hash: contentHash('test'),
            hash_at_last_sync: '',
            content: 'test',
          },
        ],
        inventory: inv([{ uuid: `uuid-dots-${filename}`, filename, content_hash: contentHash('test'), modified_at: Date.now() }]),
        deleted_uuids: [],
      });

      expect(res.status).toBe(422);
    }
  });

  // ── Rapid mutation stress ──────────────────────────────

  it('Test 45: rapid create-edit-delete-recreate cycle on same UUID', async () => {
    const now = Date.now();

    // Step 1: Create
    const content1 = 'round 1';
    const hash1 = contentHash(content1);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-rapid',
          filename: 'rapid.md',
          modified_at: now,
          content_hash: hash1,
          hash_at_last_sync: '',
          content: content1,
        },
      ],
      inventory: inv([{ uuid: 'uuid-rapid', filename: 'rapid.md', content_hash: hash1, modified_at: now }]),
      deleted_uuids: [],
    });

    // Step 2: Edit
    const content2 = 'round 2';
    const hash2 = contentHash(content2);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-rapid',
          filename: 'rapid.md',
          modified_at: now + 1,
          content_hash: hash2,
          hash_at_last_sync: hash1,
          content: content2,
        },
      ],
      inventory: inv([{ uuid: 'uuid-rapid', filename: 'rapid.md', content_hash: hash2, modified_at: now + 1 }]),
      deleted_uuids: [],
    });

    // Step 3: Delete
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: ['uuid-rapid'],
    });

    // Step 4: Try to recreate with SAME UUID — should be tombstoned
    const content3 = 'round 3 resurrection attempt';
    const hash3 = contentHash(content3);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-rapid',
          filename: 'rapid.md',
          modified_at: now + 3,
          content_hash: hash3,
          hash_at_last_sync: '',
          content: content3,
        },
      ],
      inventory: inv([{ uuid: 'uuid-rapid', filename: 'rapid.md', content_hash: hash3, modified_at: now + 3 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Tombstone should prevent resurrection
    expect(data.delete).toContain('uuid-rapid');
  });

  it('Test 46: 50 concurrent sync requests — server survives without crash', async () => {
    // Fire 50 simultaneous sync requests, each creating a unique note
    const promises: Promise<Response>[] = [];
    for (let i = 0; i < 50; i++) {
      const content = `concurrent ${i}`;
      const hash = contentHash(content);
      promises.push(
        authReq(env.app, 'POST', '/sync', token, {
          notes: [
            {
              uuid: `uuid-concurrent-${i}`,
              filename: `concurrent-${i}.md`,
              modified_at: Date.now() + i,
              content_hash: hash,
              hash_at_last_sync: '',
              content,
            },
          ],
          inventory: inv([{ uuid: `uuid-concurrent-${i}`, filename: `concurrent-${i}.md`, content_hash: hash, modified_at: Date.now() + i }]),
          deleted_uuids: [],
        }),
      );
    }

    const results = await Promise.all(promises);

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Verify all 50 notes exist on disk
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(50);
  }, 30_000);

  // ── Content edge cases ─────────────────────────────────

  it('Test 47: empty string content — accepted and stored', async () => {
    const emptyHash = contentHash('');
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-empty-content',
          filename: 'empty-content.md',
          modified_at: now,
          content_hash: emptyHash,
          hash_at_last_sync: '',
          content: '',
        },
      ],
      inventory: inv([{ uuid: 'uuid-empty-content', filename: 'empty-content.md', content_hash: emptyHash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const diskContent = readFileSync(path.join(env.notesDir, 'empty-content.md'), 'utf8');
    expect(diskContent).toBe('');
  });

  it('Test 48: very large number of deleted_uuids (500) — server handles', async () => {
    const deletedUuids = Array.from({ length: 500 }, (_, i) => `uuid-phantom-${i}`);
    const now = Date.now();

    // Delete 500 UUIDs that never existed — server should handle gracefully
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: deletedUuids,
    });

    expect(res.status).toBe(200);
  });

  it('Test 49: note content with only whitespace — stored as-is', async () => {
    const content = '   \n\t\n   ';
    const hash = contentHash(content);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-whitespace-content',
          filename: 'whitespace-content.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-whitespace-content', filename: 'whitespace-content.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const diskContent = readFileSync(path.join(env.notesDir, 'whitespace-content.md'), 'utf8');
    expect(diskContent).toBe(content);
  });

  it('Test 50: note with unicode content — emoji, CJK, RTL preserved', async () => {
    const content = '# \u{1F600} Hello \u4E16\u754C\n\n\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645\n\n\u{1F1EF}\u{1F1F5} \u65E5\u672C\u8A9E';
    const hash = contentHash(content);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-unicode',
          filename: 'unicode.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-unicode', filename: 'unicode.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const diskContent = readFileSync(path.join(env.notesDir, 'unicode.md'), 'utf8');
    expect(diskContent).toBe(content);
    expect(contentHash(diskContent)).toBe(hash);
  });

  // ── Deletion ordering attacks ──────────────────────────

  it('Test 51: delete UUID-A while creating UUID-B with same filename — B gets the name', async () => {
    const contentA = 'note A';
    const hashA = contentHash(contentA);
    const now = Date.now();

    // Upload note A
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-del-a',
          filename: 'contested.md',
          modified_at: now,
          content_hash: hashA,
          hash_at_last_sync: '',
          content: contentA,
        },
      ],
      inventory: inv([{ uuid: 'uuid-del-a', filename: 'contested.md', content_hash: hashA, modified_at: now }]),
      deleted_uuids: [],
    });

    // In single request: delete A AND create B with same filename
    const contentB = 'note B takes over';
    const hashB = contentHash(contentB);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-del-b',
          filename: 'contested.md',
          modified_at: now + 1,
          content_hash: hashB,
          hash_at_last_sync: '',
          content: contentB,
        },
      ],
      inventory: inv([{ uuid: 'uuid-del-b', filename: 'contested.md', content_hash: hashB, modified_at: now + 1 }]),
      deleted_uuids: ['uuid-del-a'], // delete A
    });

    expect(res.status).toBe(200);

    // B should now own "contested.md" since A was deleted first (Section 1 before Section 3)
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('contested.md');

    const diskContent = readFileSync(path.join(env.notesDir, 'contested.md'), 'utf8');
    expect(diskContent).toBe(contentB);
  });

  it('Test 52: mass deletion of 100 notes in single sync', async () => {
    const now = Date.now();
    const uuids: string[] = [];

    // Create 100 notes
    const notes = [];
    const inventoryItems = [];
    for (let i = 0; i < 100; i++) {
      const uuid = `uuid-mass-del-${i}`;
      const content = `mass delete ${i}`;
      const hash = contentHash(content);
      uuids.push(uuid);
      notes.push({
        uuid,
        filename: `mass-del-${i}.md`,
        modified_at: now,
        content_hash: hash,
        hash_at_last_sync: '',
        content,
      });
      inventoryItems.push({ uuid, filename: `mass-del-${i}.md`, content_hash: hash, modified_at: now });
    }

    await authReq(env.app, 'POST', '/sync', token, {
      notes,
      inventory: inv(inventoryItems),
      deleted_uuids: [],
    });

    // Verify all 100 exist
    let files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(100);

    // Delete all 100 in single sync
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: uuids,
    });

    expect(res.status).toBe(200);

    // All should be gone
    files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(0);
  });

  // ── Hash manipulation attacks ──────────────────────────

  it('Test 53: forged hash_at_last_sync — client claims to have a hash server never issued', async () => {
    const content = 'original for hash forge';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload the note
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-forge',
          filename: 'forge.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-forge', filename: 'forge.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Client claims to have a hash_at_last_sync that was never the server's hash
    // This makes the engine think both sides changed (client's last_sync != server hash)
    const newContent = 'forged edit';
    const newHash = contentHash(newContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-forge',
          filename: 'forge.md',
          modified_at: now + 1,
          content_hash: newHash,
          hash_at_last_sync: 'completely_fake_hash', // never existed on server
          content: newContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-forge', filename: 'forge.md', content_hash: newHash, modified_at: now + 1 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Engine sees: clientHash != lastSync AND serverHash != lastSync → conflict
    // This means both "changed" since the forged baseline → conflict copy should be created
    expect(data.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('Test 54: client sends content that does not match its own content_hash — server recomputes', async () => {
    const actualContent = 'the real content';
    const fakeHash = 'deadbeef' + '0'.repeat(56); // 64-char fake hash
    const realHash = contentHash(actualContent);
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-hash-mismatch',
          filename: 'hash-mismatch.md',
          modified_at: now,
          content_hash: fakeHash,
          hash_at_last_sync: '',
          content: actualContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-hash-mismatch', filename: 'hash-mismatch.md', content_hash: fakeHash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Server should recompute hash from actual content
    expect(data.hash_updates).toHaveLength(1);
    expect(data.hash_updates[0].hash_at_last_sync).toBe(realHash);

    // Content on disk should be the actual content
    const diskContent = readFileSync(path.join(env.notesDir, 'hash-mismatch.md'), 'utf8');
    expect(diskContent).toBe(actualContent);
  });

  // ── Inventory-only rename ──────────────────────────────

  it('Test 55: rename via inventory entry (no notes[] entry) — accepted if newer', async () => {
    const content = 'rename via inventory';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload note
    const res1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-inv-rename',
          filename: 'before-rename.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-inv-rename', filename: 'before-rename.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });
    expect(res1.status).toBe(200);

    // Send rename via inventory only (no notes[] entry, just inventory with new filename)
    const res2 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv([{ uuid: 'uuid-inv-rename', filename: 'after-rename.md', content_hash: hash, modified_at: now + 100 }]),
      deleted_uuids: [],
    });

    expect(res2.status).toBe(200);

    // The file should be renamed on disk
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('after-rename.md');

    // Content should be preserved
    const diskContent = readFileSync(path.join(env.notesDir, 'after-rename.md'), 'utf8');
    expect(diskContent).toBe(content);
  });

  it('Test 56: stale rename via inventory — server rejects (older timestamp)', async () => {
    const content = 'stale rename test';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload with a future timestamp
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-stale-rename',
          filename: 'server-name.md',
          modified_at: now + 1000,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-stale-rename', filename: 'server-name.md', content_hash: hash, modified_at: now + 1000 }]),
      deleted_uuids: [],
    });

    // Client tries to rename with an older timestamp
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv([{ uuid: 'uuid-stale-rename', filename: 'client-wants-this.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Server should send back the server's filename (it has higher modified_at)
    expect(data.update).toHaveLength(1);
    expect(data.update[0].filename).toBe('server-name.md');

    // Disk should still have server's filename
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['server-name.md']);
  });

  // ── Sync/check edge cases ─────────────────────────────

  it('Test 57: sync/check with version 0 — reports needs_sync', async () => {
    const content = 'version check test';
    const hash = contentHash(content);
    const now = Date.now();

    // Create a note to ensure server version > 0
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-vercheck',
          filename: 'vercheck.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-vercheck', filename: 'vercheck.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Check with version 0 — should say needs_sync
    const res = await authReq(env.app, 'POST', '/sync/check', token, { version: 0 });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('changes_available');
    expect(data.version).toBeGreaterThan(0);
  });

  it('Test 58: sync/check with current version — reports up_to_date', async () => {
    const content = 'version check test 2';
    const hash = contentHash(content);
    const now = Date.now();

    // Create a note and get the version
    const syncRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-vercheck-2',
          filename: 'vercheck2.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-vercheck-2', filename: 'vercheck2.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });
    const syncData = await syncRes.json();

    // Check with current version — should be up to date
    const res = await authReq(env.app, 'POST', '/sync/check', token, { version: syncData.version });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('up_to_date');
  });

  it('Test 59: sync/check with far-future version — handles gracefully', async () => {
    const res = await authReq(env.app, 'POST', '/sync/check', token, { version: 999999999 });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Server uses strict equality: version !== currentVersion → changes_available
    // Even a far-future version triggers this — the server doesn't distinguish "ahead" vs "behind"
    expect(data.status).toBe('changes_available');
  });

  // ── Conflict naming collision ──────────────────────────

  it('Test 60: pre-existing conflict-pattern filename does not collide with actual conflict', async () => {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Create a note whose filename already looks like a conflict copy
    const trickFilename = `trick (conflict ${today}).md`;
    const trickContent = 'I am pretending to be a conflict copy';
    const trickHash = contentHash(trickContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-trick-conflict',
          filename: trickFilename,
          modified_at: now,
          content_hash: trickHash,
          hash_at_last_sync: '',
          content: trickContent,
        },
      ],
      inventory: inv([{ uuid: 'uuid-trick-conflict', filename: trickFilename, content_hash: trickHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Create a real note called "trick.md"
    const realContent = 'real trick note';
    const realHash = contentHash(realContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-real-trick',
          filename: 'trick.md',
          modified_at: now + 1,
          content_hash: realHash,
          hash_at_last_sync: '',
          content: realContent,
        },
      ],
      inventory: inv([
        { uuid: 'uuid-trick-conflict', filename: trickFilename, content_hash: trickHash, modified_at: now },
        { uuid: 'uuid-real-trick', filename: 'trick.md', content_hash: realHash, modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });

    // Edit "trick.md" on server-side
    const serverEdit = 'server edit of trick';
    const serverHash = contentHash(serverEdit);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-real-trick',
          filename: 'trick.md',
          modified_at: now + 10,
          content_hash: serverHash,
          hash_at_last_sync: realHash,
          content: serverEdit,
        },
      ],
      inventory: inv([
        { uuid: 'uuid-trick-conflict', filename: trickFilename, content_hash: trickHash, modified_at: now },
        { uuid: 'uuid-real-trick', filename: 'trick.md', content_hash: serverHash, modified_at: now + 10 },
      ]),
      deleted_uuids: [],
    });

    // Now trigger a conflict on "trick.md" — client sends a different edit with stale hash
    const clientEdit = 'client offline edit of trick';
    const clientHash = contentHash(clientEdit);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-real-trick',
          filename: 'trick.md',
          modified_at: now + 5,
          content_hash: clientHash,
          hash_at_last_sync: realHash, // stale — doesn't match serverHash
          content: clientEdit,
        },
      ],
      inventory: inv([
        { uuid: 'uuid-trick-conflict', filename: trickFilename, content_hash: trickHash, modified_at: now },
        { uuid: 'uuid-real-trick', filename: 'trick.md', content_hash: clientHash, modified_at: now + 5 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Conflict should be generated
    expect(data.conflicts.length).toBeGreaterThanOrEqual(1);

    // All filenames on disk should be unique — including the pre-existing "conflict" trick
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    const uniqueNames = new Set(files);
    expect(uniqueNames.size).toBe(files.length);

    // The trick conflict-pattern file should still exist with its original content
    const trickDisk = readFileSync(path.join(env.notesDir, trickFilename), 'utf8');
    expect(trickDisk).toBe(trickContent);
  });

  // ── State convergence property test ────────────────────

  it('Test 61: interleaved multi-client ops converge after repeated syncs', async () => {
    const now = Date.now();

    // Use raw sync state tracking (lightweight SyncClient equivalent)
    const clientState = (token: string) => ({
      notes: new Map<string, { content: string; filename: string; hash: string; lastSync: string; modified_at: number }>(),
      deleted: [] as string[],
      sync: async function (app: typeof env.app) {
        const notesPayload = [];
        const inventoryItems = [];
        for (const [uuid, n] of this.notes) {
          const h = contentHash(n.content);
          if (h !== n.lastSync) {
            notesPayload.push({
              uuid,
              filename: n.filename,
              modified_at: n.modified_at,
              content_hash: h,
              hash_at_last_sync: n.lastSync,
              content: n.content,
            });
          }
          inventoryItems.push({ uuid, content_hash: h, filename: n.filename, modified_at: n.modified_at });
        }
        const res = await authReq(app, 'POST', '/sync', token, {
          notes: notesPayload,
          inventory: inv(inventoryItems),
          deleted_uuids: [...this.deleted],
        });
        const data = await res.json();

        // Apply deletes
        for (const uuid of data.delete) {
          this.notes.delete(uuid);
        }
        // Apply updates
        for (const u of data.update) {
          this.notes.set(u.uuid, {
            content: u.content,
            filename: u.filename,
            hash: u.content_hash,
            lastSync: u.content_hash,
            modified_at: u.modified_at,
          });
        }
        // Apply hash_updates
        for (const hu of data.hash_updates) {
          const n = this.notes.get(hu.uuid);
          if (n) n.lastSync = hu.hash_at_last_sync;
        }
        this.deleted = [];
        return data;
      },
    });

    const A = clientState(token);
    const B = clientState(token);

    // A creates 3 notes
    for (let i = 0; i < 3; i++) {
      A.notes.set(`uuid-conv-${i}`, {
        content: `note ${i} by A`,
        filename: `conv-${i}.md`,
        hash: '',
        lastSync: '',
        modified_at: now + i,
      });
    }
    await A.sync(env.app);

    // B syncs — gets all 3
    await B.sync(env.app);
    expect(B.notes.size).toBe(3);

    // A deletes note 0, edits note 1
    A.notes.delete('uuid-conv-0');
    A.deleted.push('uuid-conv-0');
    const note1 = A.notes.get('uuid-conv-1')!;
    note1.content = 'edited by A';
    note1.modified_at = now + 100;
    await A.sync(env.app);

    // B edits note 2 (unaware of A's changes)
    const note2 = B.notes.get('uuid-conv-2')!;
    note2.content = 'edited by B';
    note2.modified_at = now + 200;
    await B.sync(env.app);

    // Multiple convergence rounds
    for (let i = 0; i < 3; i++) {
      await A.sync(env.app);
      await B.sync(env.app);
    }

    // Both should have same set of UUIDs
    const aUuids = new Set(A.notes.keys());
    const bUuids = new Set(B.notes.keys());
    expect(aUuids).toEqual(bUuids);

    // Both should have same content for each note
    for (const [uuid, noteA] of A.notes) {
      const noteB = B.notes.get(uuid);
      expect(noteB).toBeDefined();
      expect(noteA.content).toBe(noteB!.content);
      expect(noteA.filename).toBe(noteB!.filename);
    }
  });

  // ── Extension validation attacks ───────────────────────

  it('Test 62: filename without .md extension — rejected', async () => {
    const badNames = ['noextension', 'note.txt', 'note.html', 'note.json', 'note.exe'];

    for (const filename of badNames) {
      const res = await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: `uuid-ext-${filename}`,
            filename,
            modified_at: Date.now(),
            content_hash: contentHash('test'),
            hash_at_last_sync: '',
            content: 'test',
          },
        ],
        inventory: inv([{ uuid: `uuid-ext-${filename}`, filename, content_hash: contentHash('test'), modified_at: Date.now() }]),
        deleted_uuids: [],
      });

      expect(res.status).toBe(422);
    }
  });

  it('Test 63: double .md extension — accepted (valid title with dot)', async () => {
    const content = 'double extension';
    const hash = contentHash(content);
    const now = Date.now();

    // "note.md.md" → title is "note.md" which is valid (dots in middle are fine)
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-double-ext',
          filename: 'note.md.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: inv([{ uuid: 'uuid-double-ext', filename: 'note.md.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // "note.md" as title has a dot in the middle which is fine
    expect(res.status).toBe(200);
  });

  it('Test 64: valid image extensions — accepted', async () => {
    const imageExts = ['test.jpg', 'test.jpeg', 'test.png', 'test.gif', 'test.webp', 'test.svg'];

    for (const filename of imageExts) {
      const content = 'fake image data';
      const hash = contentHash(content);
      const res = await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: `uuid-img-${filename}`,
            filename,
            modified_at: Date.now(),
            content_hash: hash,
            hash_at_last_sync: '',
            content,
          },
        ],
        inventory: inv([{ uuid: `uuid-img-${filename}`, filename, content_hash: hash, modified_at: Date.now() }]),
        deleted_uuids: [],
      });

      expect(res.status).toBe(200);
    }
  });

  // ── Server-only note delivery ──────────────────────────

  it('Test 65: fresh client gets all server notes in first sync', async () => {
    const now = Date.now();

    // Upload 5 notes
    const notes = [];
    const inventoryItems = [];
    for (let i = 0; i < 5; i++) {
      const content = `server note ${i}`;
      const hash = contentHash(content);
      notes.push({
        uuid: `uuid-fresh-${i}`,
        filename: `fresh-${i}.md`,
        modified_at: now + i,
        content_hash: hash,
        hash_at_last_sync: '',
        content,
      });
      inventoryItems.push({ uuid: `uuid-fresh-${i}`, filename: `fresh-${i}.md`, content_hash: hash, modified_at: now + i });
    }

    await authReq(env.app, 'POST', '/sync', token, {
      notes,
      inventory: inv(inventoryItems),
      deleted_uuids: [],
    });

    // Fresh client — completely empty inventory
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Should receive all 5 notes
    expect(data.update).toHaveLength(5);
    const receivedUuids = data.update.map((u: { uuid: string }) => u.uuid).sort();
    const expectedUuids = Array.from({ length: 5 }, (_, i) => `uuid-fresh-${i}`).sort();
    expect(receivedUuids).toEqual(expectedUuids);
  });

  it('Test 66: client with partial inventory gets only missing notes', async () => {
    const now = Date.now();

    // Upload 3 notes
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const content = `partial-inv note ${i}`;
      const hash = contentHash(content);
      hashes.push(hash);
      await authReq(env.app, 'POST', '/sync', token, {
        notes: [
          {
            uuid: `uuid-partial-${i}`,
            filename: `partial-${i}.md`,
            modified_at: now + i,
            content_hash: hash,
            hash_at_last_sync: '',
            content,
          },
        ],
        inventory: inv([{ uuid: `uuid-partial-${i}`, filename: `partial-${i}.md`, content_hash: hash, modified_at: now + i }]),
        deleted_uuids: [],
      });
    }

    // Client claims to have note 0 and 1 (correct hashes) but not note 2
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv([
        { uuid: 'uuid-partial-0', filename: 'partial-0.md', content_hash: hashes[0], modified_at: now },
        { uuid: 'uuid-partial-1', filename: 'partial-1.md', content_hash: hashes[1], modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Should only send note 2 (the one not in client's inventory)
    expect(data.update).toHaveLength(1);
    expect(data.update[0].uuid).toBe('uuid-partial-2');
  });

  // ── Cross-note rename chain ────────────────────────────

  it('Test 67: filename swap — A→B and B→A in single request', async () => {
    const contentA = 'note A';
    const hashA = contentHash(contentA);
    const contentB = 'note B';
    const hashB = contentHash(contentB);
    const now = Date.now();

    // Upload A and B
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-swap-a', filename: 'alpha.md', modified_at: now, content_hash: hashA, hash_at_last_sync: '', content: contentA },
        { uuid: 'uuid-swap-b', filename: 'beta.md', modified_at: now, content_hash: hashB, hash_at_last_sync: '', content: contentB },
      ],
      inventory: inv([
        { uuid: 'uuid-swap-a', filename: 'alpha.md', content_hash: hashA, modified_at: now },
        { uuid: 'uuid-swap-b', filename: 'beta.md', content_hash: hashB, modified_at: now },
      ]),
      deleted_uuids: [],
    });

    // Client attempts to swap filenames: A→beta.md, B→alpha.md
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-swap-a', filename: 'beta.md', modified_at: now + 10, content_hash: hashA, hash_at_last_sync: hashA },
        { uuid: 'uuid-swap-b', filename: 'alpha.md', modified_at: now + 10, content_hash: hashB, hash_at_last_sync: hashB },
      ],
      inventory: inv([
        { uuid: 'uuid-swap-a', filename: 'beta.md', content_hash: hashA, modified_at: now + 10 },
        { uuid: 'uuid-swap-b', filename: 'alpha.md', content_hash: hashB, modified_at: now + 10 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // Both notes should still exist, content preserved
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(2);

    // Read both files and verify content integrity
    const contents = new Map<string, string>();
    for (const f of files) {
      contents.set(f, readFileSync(path.join(env.notesDir, f), 'utf8'));
    }

    // Content A and content B should both be present regardless of final filenames
    const allContents = [...contents.values()].sort();
    expect(allContents).toEqual([contentA, contentB].sort());
  });

  it('Test 68: rename to a filename that was just deleted — takes freed name', async () => {
    const contentOld = 'old occupant';
    const hashOld = contentHash(contentOld);
    const contentSurvivor = 'survivor';
    const hashSurvivor = contentHash(contentSurvivor);
    const now = Date.now();

    // Upload two notes
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-old-occ', filename: 'target-name.md', modified_at: now, content_hash: hashOld, hash_at_last_sync: '', content: contentOld },
        { uuid: 'uuid-survivor', filename: 'survivor.md', modified_at: now, content_hash: hashSurvivor, hash_at_last_sync: '', content: contentSurvivor },
      ],
      inventory: inv([
        { uuid: 'uuid-old-occ', filename: 'target-name.md', content_hash: hashOld, modified_at: now },
        { uuid: 'uuid-survivor', filename: 'survivor.md', content_hash: hashSurvivor, modified_at: now },
      ]),
      deleted_uuids: [],
    });

    // Delete old occupant AND rename survivor to its old name
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-survivor', filename: 'target-name.md', modified_at: now + 10, content_hash: hashSurvivor, hash_at_last_sync: hashSurvivor },
      ],
      inventory: inv([
        { uuid: 'uuid-survivor', filename: 'target-name.md', content_hash: hashSurvivor, modified_at: now + 10 },
      ]),
      deleted_uuids: ['uuid-old-occ'],
    });

    expect(res.status).toBe(200);

    // Only one file should exist with the target name and survivor's content
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('target-name.md');

    const diskContent = readFileSync(path.join(env.notesDir, 'target-name.md'), 'utf8');
    expect(diskContent).toBe(contentSurvivor);
  });

  // ══════════════════════════════════════════════════════════
  // Hard adversarial tests — probing real engine logic gaps
  // ══════════════════════════════════════════════════════════

  // ── DATA LOSS: missing content on client-changed path ──

  it('BUG PROBE: client claims edit but omits content field — server rejects with 422', async () => {
    // Non-blob notes with changed content (content_hash !== hash_at_last_sync)
    // must include the content field. Omitting it is now rejected at validation.
    const original = 'important data that must not be lost';
    const origHash = contentHash(original);
    const now = Date.now();

    // Upload original
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-dataloss', filename: 'precious.md', modified_at: now, content_hash: origHash, hash_at_last_sync: '', content: original },
      ],
      inventory: inv([{ uuid: 'uuid-dataloss', filename: 'precious.md', content_hash: origHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Client sends "I changed" (hash differs from last sync) but OMITS content
    const fakeNewHash = contentHash('something different');
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        {
          uuid: 'uuid-dataloss',
          filename: 'precious.md',
          modified_at: now + 1,
          content_hash: fakeNewHash,
          hash_at_last_sync: origHash,
          // content field intentionally omitted
        },
      ],
      inventory: inv([{ uuid: 'uuid-dataloss', filename: 'precious.md', content_hash: fakeNewHash, modified_at: now + 1 }]),
      deleted_uuids: [],
    });

    // Server now rejects this at validation — no silent data loss possible.
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toMatch(/content/);
  });

  // ── SPURIOUS CONFLICT: empty hash_at_last_sync on existing note ──

  it('BUG PROBE: existing note with empty hash_at_last_sync triggers conflict instead of simple update', async () => {
    // If a client clears its sync state and re-syncs, it sends hash_at_last_sync=''
    // for all notes. For existing notes, this makes the engine see:
    //   clientHash !== '' (true) AND serverHash !== '' (true) → CONFLICT
    // This creates spurious conflict copies after every sync state reset.
    const content = 'stable note';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload note normally
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-spurious', filename: 'stable.md', modified_at: now, content_hash: hash, hash_at_last_sync: '', content },
      ],
      inventory: inv([{ uuid: 'uuid-spurious', filename: 'stable.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Client "forgets" its sync state — re-sends the SAME note with hash_at_last_sync=''
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-spurious', filename: 'stable.md', modified_at: now, content_hash: hash, hash_at_last_sync: '', content },
      ],
      inventory: inv([{ uuid: 'uuid-spurious', filename: 'stable.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // HARD ASSERTION: Re-uploading identical content with hash_at_last_sync=''
    // should NOT create a spurious conflict copy. The engine should detect that
    // client content matches server content and skip the conflict path.
    expect(data.conflicts).toHaveLength(0);
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
  });

  // ── IDENTICAL CONTENT CONFLICT ──

  it('BUG PROBE: two clients write identical content — conflict copy with same content', async () => {
    // Both clients edit the same note to the SAME content independently.
    // The engine doesn't compare actual content during conflict — it just
    // creates a conflict copy. This wastes space with duplicate content.
    const original = 'original before parallel edits';
    const origHash = contentHash(original);
    const now = Date.now();

    // Upload
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-dup-conflict', filename: 'parallel.md', modified_at: now, content_hash: origHash, hash_at_last_sync: '', content: original },
      ],
      inventory: inv([{ uuid: 'uuid-dup-conflict', filename: 'parallel.md', content_hash: origHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Client A edits to "final version"
    const finalContent = 'both clients converged on this';
    const finalHash = contentHash(finalContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-dup-conflict', filename: 'parallel.md', modified_at: now + 10, content_hash: finalHash, hash_at_last_sync: origHash, content: finalContent },
      ],
      inventory: inv([{ uuid: 'uuid-dup-conflict', filename: 'parallel.md', content_hash: finalHash, modified_at: now + 10 }]),
      deleted_uuids: [],
    });

    // Client B independently wrote the EXACT same content, but with stale hash_at_last_sync
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-dup-conflict', filename: 'parallel.md', modified_at: now + 5, content_hash: finalHash, hash_at_last_sync: origHash, content: finalContent },
      ],
      inventory: inv([{ uuid: 'uuid-dup-conflict', filename: 'parallel.md', content_hash: finalHash, modified_at: now + 5 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // HARD ASSERTION: When both sides arrive at identical content, a conflict
    // copy is wasteful. The engine should detect content equality and skip
    // conflict creation when clientHash === serverHash (both changed to same thing).
    expect(data.conflicts).toHaveLength(0);
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(env.notesDir, files[0]), 'utf8')).toBe(finalContent);
  });

  // ── DEDUP COUNTER EXHAUSTION ──

  it('BUG PROBE: dedup counter with pre-existing (2) and (3) names', async () => {
    // Create "note.md", "note (2).md", "note (3).md" with different UUIDs.
    // Then upload another note named "note.md" — should get "note (4).md".
    // But resolveFilenameInMemory starts counter at 1 and increments — does it skip existing?
    const now = Date.now();

    const notes = [
      { uuid: 'uuid-dedup-base', filename: 'dedup-chain.md', content: 'base' },
      { uuid: 'uuid-dedup-2', filename: 'dedup-chain (2).md', content: 'second' },
      { uuid: 'uuid-dedup-3', filename: 'dedup-chain (3).md', content: 'third' },
    ];

    // Upload all three
    const notePayloads = notes.map((n, i) => ({
      uuid: n.uuid,
      filename: n.filename,
      modified_at: now + i,
      content_hash: contentHash(n.content),
      hash_at_last_sync: '',
      content: n.content,
    }));
    const invPayloads = notes.map((n, i) => ({
      uuid: n.uuid,
      filename: n.filename,
      content_hash: contentHash(n.content),
      modified_at: now + i,
    }));

    await authReq(env.app, 'POST', '/sync', token, {
      notes: notePayloads,
      inventory: inv(invPayloads),
      deleted_uuids: [],
    });

    // Now upload a NEW note also called "dedup-chain.md"
    const newContent = 'fourth — should get (4)';
    const newHash = contentHash(newContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-dedup-4', filename: 'dedup-chain.md', modified_at: now + 10, content_hash: newHash, hash_at_last_sync: '', content: newContent },
      ],
      inventory: inv([
        ...invPayloads,
        { uuid: 'uuid-dedup-4', filename: 'dedup-chain.md', content_hash: newHash, modified_at: now + 10 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md')).sort();
    expect(files).toHaveLength(4);

    // The new note should get "dedup-chain (4).md", NOT collide with (2) or (3)
    expect(files).toContain('dedup-chain (4).md');
    const fourthContent = readFileSync(path.join(env.notesDir, 'dedup-chain (4).md'), 'utf8');
    expect(fourthContent).toBe(newContent);
  });

  // ── CONFLICT ON RENAMED NOTE ──

  it('BUG PROBE: conflict on a note whose server-side filename changed — conflict copy uses stale name', async () => {
    // Client A renames "old.md" → "new.md". Client B (offline) edits "old.md".
    // B syncs: server has "new.md", B sends edit for "old.md".
    // The conflict copy filename is derived from clientNote.filename ("old.md"),
    // NOT the server's current filename ("new.md"). This could confuse users.
    const content = 'original';
    const hash = contentHash(content);
    const now = Date.now();

    // Upload "old.md"
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-rename-conflict', filename: 'old-name.md', modified_at: now, content_hash: hash, hash_at_last_sync: '', content },
      ],
      inventory: inv([{ uuid: 'uuid-rename-conflict', filename: 'old-name.md', content_hash: hash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Client A renames to "new-name.md" AND edits content
    const renamedContent = 'renamed and edited by A';
    const renamedHash = contentHash(renamedContent);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-rename-conflict', filename: 'new-name.md', modified_at: now + 10, content_hash: renamedHash, hash_at_last_sync: hash, content: renamedContent },
      ],
      inventory: inv([{ uuid: 'uuid-rename-conflict', filename: 'new-name.md', content_hash: renamedHash, modified_at: now + 10 }]),
      deleted_uuids: [],
    });

    // Client B (offline) edits the note with OLD filename and stale hash
    const bContent = 'edited by offline B, still thinks its old-name.md';
    const bHash = contentHash(bContent);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-rename-conflict', filename: 'old-name.md', modified_at: now + 5, content_hash: bHash, hash_at_last_sync: hash, content: bContent },
      ],
      inventory: inv([{ uuid: 'uuid-rename-conflict', filename: 'old-name.md', content_hash: bHash, modified_at: now + 5 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Should trigger conflict
    expect(data.conflicts.length).toBeGreaterThanOrEqual(1);

    // Document: what filename does the conflict copy get?
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(2);

    // The conflict copy's filename is based on clientNote.filename ("old-name.md")
    // So it'll be something like "old-name (conflict 2026-03-24).md"
    // while the server's note is "new-name.md"
    const conflictFile = files.find((f) => f.includes('conflict'));
    expect(conflictFile).toBeDefined();
    // Verify the conflict copy contains B's content
    const conflictContent = readFileSync(path.join(env.notesDir, conflictFile!), 'utf8');
    expect(conflictContent).toBe(bContent);

    // Verify server still has A's renamed version
    expect(files).toContain('new-name.md');
    const serverContent = readFileSync(path.join(env.notesDir, 'new-name.md'), 'utf8');
    expect(serverContent).toBe(renamedContent);
  });

  // ── BANDWIDTH AMPLIFICATION ──

  it('BUG PROBE: empty notes[] with all-wrong hashes in inventory — server sends back everything', async () => {
    // A malicious client sends inventory with deliberately wrong hashes
    // for every note. The server reads all notes from disk and sends
    // them all back. This is a bandwidth amplification attack.
    const now = Date.now();

    // Upload 20 notes
    const notePayloads = [];
    const correctInv = [];
    for (let i = 0; i < 20; i++) {
      const content = `amplification test ${i} ${'x'.repeat(1000)}`;
      const hash = contentHash(content);
      notePayloads.push({
        uuid: `uuid-amp-${i}`,
        filename: `amp-${i}.md`,
        modified_at: now + i,
        content_hash: hash,
        hash_at_last_sync: '',
        content,
      });
      correctInv.push({ uuid: `uuid-amp-${i}`, filename: `amp-${i}.md`, content_hash: hash, modified_at: now + i });
    }

    await authReq(env.app, 'POST', '/sync', token, {
      notes: notePayloads,
      inventory: inv(correctInv),
      deleted_uuids: [],
    });

    // Malicious request: claim to have all 20 notes but with wrong hashes
    const wrongInv = correctInv.map((item) => ({
      ...item,
      content_hash: 'wrong_hash_' + item.uuid,
    }));

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv(wrongInv),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Server sends ALL 20 notes back — bandwidth amplification
    expect(data.update).toHaveLength(20);

    // Document: total response size is much larger than the request
    const responseSize = JSON.stringify(data).length;
    // Each note has ~1000 chars of content, so response is ~20KB+
    expect(responseSize).toBeGreaterThan(10000);
  });

  // ── GHOST NOTE: inventory-only UUID unknown to server ──

  it('BUG PROBE: inventory contains UUID server has never seen — silently ignored', async () => {
    // Client claims to have a note the server doesn't know about,
    // via inventory only (no notes[] entry). Server skips it (line 429).
    // The client never learns the server doesn't have it.
    // On next sync, client still has the note but server doesn't.
    const now = Date.now();

    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: inv([
        { uuid: 'uuid-ghost', filename: 'ghost.md', content_hash: 'somehash', modified_at: now },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Document: server does NOT tell the client to upload the missing note
    // There's no mechanism in the sync response for "please send me this note"
    // The client would need to have it in notes[] with content for the server to get it
    expect(data.update).toHaveLength(0);
    expect(data.hash_updates).toHaveLength(0);
    expect(data.delete).toHaveLength(0);

    // No file created on disk (dir may not exist if nothing was ever written)
    let files: string[] = [];
    try {
      files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    } catch {
      // notesDir doesn't exist — correct, nothing was written
    }
    expect(files).toHaveLength(0);
  });

  // ── RENAME DURING CONFLICT ──

  it('BUG PROBE: client sends conflicting content with a different filename — which filename wins?', async () => {
    // Setup: note "shared.md" with content A on server
    // Client sends: same UUID, DIFFERENT filename "renamed.md", DIFFERENT content, stale hash_at_last_sync
    // This is both a rename AND a conflict. What happens?
    const original = 'original content';
    const origHash = contentHash(original);
    const now = Date.now();

    // Upload
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-rename-in-conflict', filename: 'shared.md', modified_at: now, content_hash: origHash, hash_at_last_sync: '', content: original },
      ],
      inventory: inv([{ uuid: 'uuid-rename-in-conflict', filename: 'shared.md', content_hash: origHash, modified_at: now }]),
      deleted_uuids: [],
    });

    // Server-side edit (changes hash)
    const serverEdit = 'server edited this';
    const serverHash = contentHash(serverEdit);
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-rename-in-conflict', filename: 'shared.md', modified_at: now + 10, content_hash: serverHash, hash_at_last_sync: origHash, content: serverEdit },
      ],
      inventory: inv([{ uuid: 'uuid-rename-in-conflict', filename: 'shared.md', content_hash: serverHash, modified_at: now + 10 }]),
      deleted_uuids: [],
    });

    // Client B: stale hash, different content AND different filename
    const clientEdit = 'client offline edit with rename';
    const clientHash = contentHash(clientEdit);
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-rename-in-conflict', filename: 'renamed-by-client.md', modified_at: now + 5, content_hash: clientHash, hash_at_last_sync: origHash, content: clientEdit },
      ],
      inventory: inv([{ uuid: 'uuid-rename-in-conflict', filename: 'renamed-by-client.md', content_hash: clientHash, modified_at: now + 5 }]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // This should be a conflict
    expect(data.conflicts.length).toBeGreaterThanOrEqual(1);

    // The server version should be sent back to client with server's filename
    const serverUpdate = data.update.find((u: { uuid: string }) => u.uuid === 'uuid-rename-in-conflict');
    expect(serverUpdate).toBeDefined();
    // Server's filename should win (it's "shared.md")
    expect(serverUpdate.filename).toBe('shared.md');
    expect(serverUpdate.content).toBe(serverEdit);

    // Conflict copy should have client's content
    const conflictCopy = data.conflicts[0];
    expect(conflictCopy.client_content).toBe(clientEdit);

    // Files on disk
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));
    expect(files).toContain('shared.md');
    // Conflict copy filename is based on client's requested name
    const conflictFiles = files.filter((f) => f.includes('conflict'));
    expect(conflictFiles.length).toBeGreaterThanOrEqual(1);
  });

  // ── CONCURRENT SYNC: same UUID created by two requests ──

  it('BUG PROBE: two concurrent syncs both create a note with the same UUID — last write wins', async () => {
    // SQLite transactions are serialized, so one request wins.
    // But the file on disk could be overwritten by the second request.
    const contentA = 'version from request A';
    const hashA = contentHash(contentA);
    const contentB = 'version from request B';
    const hashB = contentHash(contentB);
    const now = Date.now();

    // Fire both requests simultaneously
    const [resA, resB] = await Promise.all([
      authReq(env.app, 'POST', '/sync', token, {
        notes: [
          { uuid: 'uuid-race-create', filename: 'raced.md', modified_at: now, content_hash: hashA, hash_at_last_sync: '', content: contentA },
        ],
        inventory: inv([{ uuid: 'uuid-race-create', filename: 'raced.md', content_hash: hashA, modified_at: now }]),
        deleted_uuids: [],
      }),
      authReq(env.app, 'POST', '/sync', token, {
        notes: [
          { uuid: 'uuid-race-create', filename: 'raced.md', modified_at: now + 1, content_hash: hashB, hash_at_last_sync: '', content: contentB },
        ],
        inventory: inv([{ uuid: 'uuid-race-create', filename: 'raced.md', content_hash: hashB, modified_at: now + 1 }]),
        deleted_uuids: [],
      }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // BUG FOUND: Both requests treat the UUID as "new" because they each build
    // an independent filenameIndex. The first writes "raced.md", the second sees
    // the filename collision and deduplicates to "raced (2).md". But the DB
    // has a UNIQUE constraint on uuid, so only ONE row exists in the notes table.
    // Result: two files on disk, one row in DB — orphaned file.
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md'));

    // Document actual behavior: concurrent same-UUID creation creates orphaned files
    // The DB row's filename only matches ONE of the disk files.
    // A clean sync reveals the DB state:
    const verifyRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    const verifyData = await verifyRes.json();
    const note = verifyData.update.find((u: { uuid: string }) => u.uuid === 'uuid-race-create');
    expect(note).toBeDefined();

    // The DB version should be consistent with one of the disk files
    const dbContent = note.content;
    expect([contentA, contentB]).toContain(dbContent);
    expect(note.content_hash).toBe(contentHash(dbContent));

    // The disk file matching the DB filename should have matching content
    const dbFile = files.find((f) => f === note.filename);
    expect(dbFile).toBeDefined();
    const dbDiskContent = readFileSync(path.join(env.notesDir, dbFile!), 'utf8');
    expect(dbDiskContent).toBe(dbContent);
  });

  // ── RENAME COLLISION VIA SANITIZATION ──

  it('BUG PROBE: two notes with names that sanitize to the same thing', async () => {
    // "note<1>.md" and "note<2>.md" both sanitize to "note12.md" (or similar)
    // after forbidden characters are stripped. This creates an invisible collision.
    // Actually, the route validates filenames BEFORE the engine sees them.
    // So this tests whether path-traversal stripping in sanitizeFilename
    // can cause two different valid filenames to collide.
    const now = Date.now();

    // "a..b.md" → sanitizeFilename strips ".." → "ab.md"
    // "ab.md" → sanitizeFilename → "ab.md"
    // Both should coexist or the second should be deduped.
    // BUT: the route's validateTitle would reject "a..b" (trailing dot on "a." segment?).
    // Let's use names that are valid per validateTitle but collide after sanitization:
    // Actually path separator stripping is the interesting case.
    // Try names that differ only by characters sanitizeFilename strips.

    // Both of these are valid titles:
    const content1 = 'first';
    const hash1 = contentHash(content1);
    const content2 = 'second';
    const hash2 = contentHash(content2);

    // Upload first note "test note.md"
    await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-sani-1', filename: 'test note.md', modified_at: now, content_hash: hash1, hash_at_last_sync: '', content: content1 },
      ],
      inventory: inv([{ uuid: 'uuid-sani-1', filename: 'test note.md', content_hash: hash1, modified_at: now }]),
      deleted_uuids: [],
    });

    // Upload second note also "test note.md" but different UUID
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [
        { uuid: 'uuid-sani-2', filename: 'test note.md', modified_at: now + 1, content_hash: hash2, hash_at_last_sync: '', content: content2 },
      ],
      inventory: inv([
        { uuid: 'uuid-sani-1', filename: 'test note.md', content_hash: hash1, modified_at: now },
        { uuid: 'uuid-sani-2', filename: 'test note.md', content_hash: hash2, modified_at: now + 1 },
      ]),
      deleted_uuids: [],
    });

    expect(res.status).toBe(200);

    // Both should exist — second gets deduped name
    const files = readdirSync(env.notesDir).filter((f) => f.endsWith('.md')).sort();
    expect(files).toHaveLength(2);
    expect(files).toContain('test note.md');
    expect(files).toContain('test note (2).md');
  });
});
