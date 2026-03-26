import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnv, type TestEnv } from '../helpers/setup.js';
import { getDb } from '../../src/db/index.js';
import { upsertNote } from '../../src/db/notes.js';
import { createTombstone } from '../../src/db/tombstones.js';
import { writeNoteFile, writeBlobFile } from '../../src/sync/files.js';
import { contentHash, binaryContentHash } from '../../src/sync/hash.js';
import { checkPostSyncInvariants } from '../../src/sync/invariants.js';
import type { SyncResponse } from '@futo-notes/shared';

const EMPTY_RESPONSE: SyncResponse = {
  update: [],
  delete: [],
  hash_updates: [],
  conflicts: [],
};

describe('post-sync invariants', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
    fs.mkdirSync(env.notesDir, { recursive: true });
  });

  afterEach(() => {
    env.cleanup();
  });

  it('passes on clean empty state', () => {
    const db = getDb();
    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes when DB and disk are consistent', () => {
    const db = getDb();
    const content = 'hello world';
    const hash = contentHash(content);
    writeNoteFile(env.notesDir, 'test.md', content);
    upsertNote(db, 'uuid-1', 'test.md', hash, Date.now());

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 1);
    expect(result.passed).toBe(true);
  });

  it('passes with consistent blob', () => {
    const db = getDb();
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    const hash = binaryContentHash(data);
    writeBlobFile(env.notesDir, 'image.png', data);
    upsertNote(db, 'uuid-blob', 'image.png', hash, Date.now(), true);

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(true);
  });

  // ── Invariant 1: Content-hash parity ──────────────────

  it('detects content-hash mismatch for text note', () => {
    const db = getDb();
    writeNoteFile(env.notesDir, 'test.md', 'actual content on disk');
    upsertNote(db, 'uuid-1', 'test.md', contentHash('different content in db'), Date.now());

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/content-parity.*uuid-1.*hash mismatch/);
  });

  it('detects content-hash mismatch for blob', () => {
    const db = getDb();
    writeBlobFile(env.notesDir, 'photo.jpg', Buffer.from('actual bytes'));
    upsertNote(db, 'uuid-blob', 'photo.jpg', binaryContentHash(Buffer.from('wrong bytes')), Date.now(), true);

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatch(/content-parity.*uuid-blob.*hash mismatch/);
  });

  it('detects note in DB but missing from disk', () => {
    const db = getDb();
    upsertNote(db, 'uuid-ghost', 'ghost.md', contentHash('gone'), Date.now());

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatch(/content-parity.*uuid-ghost.*missing from disk/);
  });

  // ── Invariant 2: Orphaned files ───────────────────────

  it('detects orphaned .md file on disk', () => {
    const db = getDb();
    writeNoteFile(env.notesDir, 'orphan.md', 'nobody knows me');

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatch(/orphaned-file.*orphan\.md/);
  });

  it('detects orphaned image file on disk', () => {
    const db = getDb();
    writeBlobFile(env.notesDir, 'stray.png', Buffer.from('img'));

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatch(/orphaned-file.*stray\.png/);
  });

  // ── Invariant 3: Blob/extension parity ────────────────

  it('detects is_blob=1 with .md filename', () => {
    const db = getDb();
    const content = 'markdown text';
    writeNoteFile(env.notesDir, 'wrong.md', content);
    upsertNote(db, 'uuid-mislabeled', 'wrong.md', contentHash(content), Date.now(), true);

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('blob-extension') && v.includes('uuid-mislabeled'))).toBe(true);
  });

  it('detects is_blob=0 with image filename', () => {
    const db = getDb();
    const data = Buffer.from('fake image');
    writeBlobFile(env.notesDir, 'photo.jpg', data);
    // is_blob defaults to false (0) when not specified
    upsertNote(db, 'uuid-wrongtype', 'photo.jpg', binaryContentHash(data), Date.now(), false);

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('blob-extension') && v.includes('uuid-wrongtype'))).toBe(true);
  });

  // ── Invariant 4: Duplicate filenames ──────────────────

  it('detects duplicate filenames in DB', () => {
    const db = getDb();
    const content = 'same name';
    const hash = contentHash(content);
    writeNoteFile(env.notesDir, 'dupe.md', content);
    // Bypass upsertNote's ON CONFLICT by using different UUIDs
    db.prepare('INSERT INTO notes (uuid, filename, content_hash, modified_at, is_blob) VALUES (?, ?, ?, ?, 0)')
      .run('uuid-a', 'dupe.md', hash, Date.now());
    db.prepare('INSERT INTO notes (uuid, filename, content_hash, modified_at, is_blob) VALUES (?, ?, ?, ?, 0)')
      .run('uuid-b', 'dupe.md', hash, Date.now());

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('duplicate-filename') && v.includes('dupe.md'))).toBe(true);
  });

  // ── Invariant 5: Tombstone-note exclusion ─────────────

  it('detects tombstone overlapping with active note', () => {
    const db = getDb();
    const content = 'zombie';
    writeNoteFile(env.notesDir, 'zombie.md', content);
    upsertNote(db, 'uuid-zombie', 'zombie.md', contentHash(content), Date.now());
    createTombstone(db, 'uuid-zombie');

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 0, 0);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('tombstone-note-overlap') && v.includes('uuid-zombie'))).toBe(true);
  });

  // ── Invariant 6: Monotonic version ────────────────────

  it('detects version regression', () => {
    const db = getDb();
    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 5, 3);
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatch(/version-regression.*5.*3/);
  });

  it('accepts same version (no-op sync)', () => {
    const db = getDb();
    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 5, 5);
    expect(result.passed).toBe(true);
  });

  // ── Multiple violations ───────────────────────────────

  it('reports multiple violations at once', () => {
    const db = getDb();
    // Orphaned file + missing DB note file
    writeNoteFile(env.notesDir, 'orphan.md', 'lost');
    upsertNote(db, 'uuid-ghost', 'ghost.md', contentHash('gone'), Date.now());

    const result = checkPostSyncInvariants(db, env.notesDir, EMPTY_RESPONSE, 5, 3);
    expect(result.passed).toBe(false);
    // Should have: content-parity (missing), orphaned-file, version-regression
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});
