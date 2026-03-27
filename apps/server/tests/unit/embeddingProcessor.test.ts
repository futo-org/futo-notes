import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../src/db/index.js';
import { createSearchTables } from '../../src/db/searchSchema.js';
import { upsertNote } from '../../src/db/notes.js';
import { initVectorDb, resetVectorDb } from '../../src/db/vectorDb.js';
import { createEmbeddingProcessor } from '../../src/search/embeddingIndexer.js';
import type { EmbeddingModel } from '../../src/search/modelManager.js';

function makeMockModel(dims = 3): EmbeddingModel {
  return {
    model: {} as EmbeddingModel['model'],
    context: {} as EmbeddingModel['context'],
    dims,
    queryPrefix: null,
    docPrefix: null,
    embedDocuments: vi.fn(async (texts: string[]) =>
      texts.map(() => Array(dims).fill(0.1)),
    ),
    embedQuery: vi.fn(async () => Array(dims).fill(0.1)),
  };
}

describe('createEmbeddingProcessor', () => {
  let tmpDir: string;
  let notesDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-embed-test-'));
    notesDir = path.join(tmpDir, 'notes');
    mkdirSync(notesDir, { recursive: true });
    initDb(path.join(tmpDir, 'test.db'));
    createSearchTables(getDb());
    await initVectorDb(getDb(), 3);
  });

  afterEach(() => {
    resetVectorDb();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips non-.md files and marks them indexed', async () => {
    const db = getDb();
    const model = makeMockModel();

    upsertNote(db, 'img-1', 'photo.jpg', 'imghash', Date.now(), true);

    const processor = createEmbeddingProcessor(model, notesDir);
    await processor(db, ['img-1']);

    // embedDocuments should never be called
    expect(model.embedDocuments).not.toHaveBeenCalled();

    // But the note should be marked as indexed (not perpetually dirty)
    const state = db.prepare('SELECT * FROM search_index_state WHERE uuid = ?').get('img-1') as
      { content_hash: string } | undefined;
    expect(state).toBeDefined();
    expect(state!.content_hash).toBe('imghash');
  });

  it('processes .md files normally', async () => {
    const db = getDb();
    const model = makeMockModel();

    upsertNote(db, 'note-1', 'test.md', 'hash1', Date.now());
    writeFileSync(path.join(notesDir, 'test.md'), '# Hello\n\nThis is a test note with enough content.');

    const processor = createEmbeddingProcessor(model, notesDir);
    await processor(db, ['note-1']);

    expect(model.embedDocuments).toHaveBeenCalled();

    // Chunks and index state should be created
    const chunks = db.prepare('SELECT * FROM search_chunks WHERE uuid = ?').all('note-1');
    expect(chunks.length).toBeGreaterThan(0);

    const state = db.prepare('SELECT * FROM search_index_state WHERE uuid = ?').get('note-1');
    expect(state).toBeDefined();
  });

  it('one failing note does not abort the batch', async () => {
    const db = getDb();
    const model = makeMockModel();

    // Make embedDocuments fail on the second call
    let callCount = 0;
    (model.embedDocuments as ReturnType<typeof vi.fn>).mockImplementation(async (texts: string[]) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('simulated embedding failure');
      }
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    upsertNote(db, 'note-1', 'first.md', 'h1', Date.now());
    upsertNote(db, 'note-2', 'second.md', 'h2', Date.now());
    upsertNote(db, 'note-3', 'third.md', 'h3', Date.now());
    writeFileSync(path.join(notesDir, 'first.md'), '# First\n\nSome content here.');
    writeFileSync(path.join(notesDir, 'second.md'), '# Second\n\nThis one will fail.');
    writeFileSync(path.join(notesDir, 'third.md'), '# Third\n\nMore content here.');

    const processor = createEmbeddingProcessor(model, notesDir);
    // Should NOT throw — error is caught per-note
    await processor(db, ['note-1', 'note-2', 'note-3']);

    // First and third should be indexed
    const state1 = db.prepare('SELECT * FROM search_index_state WHERE uuid = ?').get('note-1');
    const state3 = db.prepare('SELECT * FROM search_index_state WHERE uuid = ?').get('note-3');
    expect(state1).toBeDefined();
    expect(state3).toBeDefined();

    // Second should NOT be indexed (it failed)
    const state2 = db.prepare('SELECT * FROM search_index_state WHERE uuid = ?').get('note-2');
    expect(state2).toBeUndefined();
  });

  it('skips deleted notes gracefully', async () => {
    const db = getDb();
    const model = makeMockModel();

    // UUID not in notes table
    const processor = createEmbeddingProcessor(model, notesDir);
    await processor(db, ['nonexistent-uuid']);

    expect(model.embedDocuments).not.toHaveBeenCalled();
  });

  it('skips notes with missing files', async () => {
    const db = getDb();
    const model = makeMockModel();

    upsertNote(db, 'note-1', 'missing.md', 'hash1', Date.now());
    // Don't create the file on disk

    const processor = createEmbeddingProcessor(model, notesDir);
    await processor(db, ['note-1']);

    expect(model.embedDocuments).not.toHaveBeenCalled();
  });
});
