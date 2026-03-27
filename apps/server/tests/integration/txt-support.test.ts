import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, authReq, type TestEnv } from '../helpers/setup.js';
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { convertTxtFiles, listNoteFiles, writeNoteFile } from '../../src/sync/files.js';
import { contentHash } from '../../src/sync/hash.js';
import { reconcile } from '../../src/sync/recovery.js';
import { getAllNotes, upsertNote } from '../../src/db/notes.js';
import { getDb } from '../../src/db/index.js';
import path from 'node:path';

describe('.txt → .md conversion', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = createTestEnv();
    await setupAndLogin(env.app);
    mkdirSync(env.notesDir, { recursive: true });
  });

  afterEach(() => env.cleanup());

  it('converts .txt files to .md', () => {
    writeFileSync(path.join(env.notesDir, 'groceries.txt'), 'milk\neggs');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('groceries.md');
    expect(files).not.toContain('groceries.txt');
  });

  it('handles collision with existing .md file', () => {
    writeFileSync(path.join(env.notesDir, 'note.md'), 'md content');
    writeFileSync(path.join(env.notesDir, 'note.txt'), 'txt content');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('note.md');
    expect(files).toContain('note (imported).md');
    expect(files).not.toContain('note.txt');
  });

  it('ignores .csv and other non-txt/md files', () => {
    writeFileSync(path.join(env.notesDir, 'data.csv'), 'a,b,c');
    writeFileSync(path.join(env.notesDir, 'script.js'), 'console.log()');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('data.csv');
    expect(files).toContain('script.js');
    // No .md files created from non-txt
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });

  it('listNoteFiles converts .txt before listing', () => {
    writeFileSync(path.join(env.notesDir, 'note-a.md'), 'a');
    writeFileSync(path.join(env.notesDir, 'note-b.txt'), 'b');

    const files = listNoteFiles(env.notesDir);
    expect(files).toContain('note-a.md');
    expect(files).toContain('note-b.md');
    expect(files).toHaveLength(2);
  });

  it('listNoteFiles converts .txt and returns only .md', () => {
    writeFileSync(path.join(env.notesDir, 'dropped-note.txt'), 'dropped content');
    writeFileSync(path.join(env.notesDir, 'existing.md'), 'existing content');

    // listNoteFiles triggers conversion, so both should appear as .md
    const files = listNoteFiles(env.notesDir).sort();
    expect(files).toEqual(['dropped-note.md', 'existing.md']);

    // Verify on disk
    const diskFiles = readdirSync(env.notesDir).sort();
    expect(diskFiles).toContain('dropped-note.md');
    expect(diskFiles).toContain('existing.md');
    expect(diskFiles).not.toContain('dropped-note.txt');
  });

  // ── Case-insensitive matching ─────────────────────────────

  it('converts .TXT files (case-insensitive)', () => {
    writeFileSync(path.join(env.notesDir, 'uppercase.TXT'), 'upper content');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('uppercase.md');
    expect(files).not.toContain('uppercase.TXT');
  });

  it('converts .Txt files (mixed case)', () => {
    writeFileSync(path.join(env.notesDir, 'mixed.Txt'), 'mixed content');

    convertTxtFiles(env.notesDir);

    const files = readdirSync(env.notesDir);
    expect(files).toContain('mixed.md');
    expect(files).not.toContain('mixed.Txt');
  });

  // ── Content preservation ──────────────────────────────────

  it('preserves file content exactly after conversion', () => {
    const content = '# My Note\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2\n';
    writeFileSync(path.join(env.notesDir, 'preserve.txt'), content);

    convertTxtFiles(env.notesDir);

    const converted = readFileSync(path.join(env.notesDir, 'preserve.md'), 'utf8');
    expect(converted).toBe(content);
  });

  // ── DB adoption via reconcile ─────────────────────────────

  it('reconcile adopts converted .txt files into DB', () => {
    const db = getDb();
    writeFileSync(path.join(env.notesDir, 'from-text.txt'), 'text content');

    reconcile(db, env.notesDir);

    // .txt should be converted and adopted
    const notes = getAllNotes(db);
    expect(notes).toHaveLength(1);
    expect(notes[0].filename).toBe('from-text.md');
    expect(notes[0].content_hash).toBe(contentHash('text content'));

    // Disk state
    expect(readdirSync(env.notesDir)).toEqual(['from-text.md']);
  });

  it('reconcile adopts multiple .txt files', () => {
    const db = getDb();
    writeFileSync(path.join(env.notesDir, 'one.txt'), 'first');
    writeFileSync(path.join(env.notesDir, 'two.txt'), 'second');
    writeFileSync(path.join(env.notesDir, 'three.txt'), 'third');

    reconcile(db, env.notesDir);

    const notes = getAllNotes(db);
    expect(notes).toHaveLength(3);
    const filenames = notes.map((n) => n.filename).sort();
    expect(filenames).toEqual(['one.md', 'three.md', 'two.md']);
  });

  it('reconcile handles collision when .md already in DB', () => {
    const db = getDb();
    // Existing .md file already in DB
    writeNoteFile(env.notesDir, 'note.md', 'md content');
    upsertNote(db, 'existing-uuid', 'note.md', contentHash('md content'), Date.now());

    // New .txt file with same base name
    writeFileSync(path.join(env.notesDir, 'note.txt'), 'txt content');

    reconcile(db, env.notesDir);

    const notes = getAllNotes(db);
    expect(notes).toHaveLength(2);

    const existing = notes.find((n) => n.uuid === 'existing-uuid');
    expect(existing).toBeDefined();
    expect(existing!.filename).toBe('note.md');

    const imported = notes.find((n) => n.uuid !== 'existing-uuid');
    expect(imported).toBeDefined();
    expect(imported!.filename).toBe('note (imported).md');
    expect(imported!.content_hash).toBe(contentHash('txt content'));
  });

  // ── Full sync round-trip ──────────────────────────────────

  it('client receives converted .txt note via sync after reconcile', async () => {
    const db = getDb();
    const token = await setupAndLogin(env.app);

    // Place .txt file on server disk and reconcile
    writeFileSync(path.join(env.notesDir, 'server-note.txt'), 'from server txt');
    reconcile(db, env.notesDir);

    // Client syncs with empty state
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { update: Array<{ filename: string; content: string }> };
    expect(body.update).toHaveLength(1);
    expect(body.update[0].filename).toBe('server-note.md');
    expect(body.update[0].content).toBe('from server txt');
  });

  it('client dedup works after server adopts .txt-converted file', async () => {
    const db = getDb();
    const token = await setupAndLogin(env.app);

    // Server has adopted a .txt file
    writeFileSync(path.join(env.notesDir, 'shared.txt'), 'shared content');
    reconcile(db, env.notesDir);

    const serverNotes = getAllNotes(db);
    const serverUuid = serverNotes[0].uuid;

    // Client syncs with same content but different UUID
    const clientUuid = 'client-uuid-1234-5678-abcdefabcdef';
    const hash = contentHash('shared content');
    const res = await authReq(env.app, 'POST', '/sync', token, {
      notes: [{
        uuid: clientUuid,
        filename: 'shared.md',
        modified_at: Date.now(),
        content_hash: hash,
        hash_at_last_sync: '',
        content: 'shared content',
      }],
      inventory: [{
        uuid: clientUuid,
        filename: 'shared.md',
        modified_at: Date.now(),
        content_hash: hash,
      }],
      deleted_uuids: [],
    });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      update: Array<{ uuid: string; filename: string }>;
      delete: string[];
    };

    // Server should tell client to delete its UUID and use server's
    expect(body.delete).toContain(clientUuid);
    // Server's version should be in update
    const serverUpdate = body.update.find((u) => u.uuid === serverUuid);
    expect(serverUpdate).toBeDefined();
    expect(serverUpdate!.filename).toBe('shared.md');
  });
});
