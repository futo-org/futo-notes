import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../src/db/index.js';
import { createSearchTables } from '../../src/db/searchSchema.js';

/**
 * Tests for the model-change re-index detection logic in the search scheduler.
 *
 * The scheduler stores `model_uri` in search_config. When the URI changes
 * (e.g., quantization switch from Q8_0 to Q4_K_M), it clears search_index_state
 * so all notes become dirty and get re-embedded.
 *
 * These tests exercise the DB-level logic directly without loading an actual model.
 */

interface TestEnv {
  tmpDir: string;
}

function setup(): TestEnv {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-model-change-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  initDb(dbPath);
  const db = getDb();
  createSearchTables(db);
  // Create the notes table (minimal schema needed for getDirtyUuids)
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      uuid TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      modified_at INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      is_blob INTEGER NOT NULL DEFAULT 0
    )
  `);
  return { tmpDir };
}

function teardown(env: TestEnv): void {
  closeDb();
  rmSync(env.tmpDir, { recursive: true, force: true });
}

function upsertConfig(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

function getConfig(key: string): string | undefined {
  const db = getDb();
  return (db.prepare("SELECT value FROM search_config WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

function insertNote(uuid: string, contentHash: string): void {
  const db = getDb();
  db.prepare('INSERT INTO notes (uuid, filename, content_hash, modified_at) VALUES (?, ?, ?, ?)')
    .run(uuid, `${uuid}.md`, contentHash, Date.now());
}

function insertIndexState(uuid: string, contentHash: string, level = 2): void {
  const db = getDb();
  db.prepare('INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, ?, ?, ?)')
    .run(uuid, level, contentHash, Date.now());
}

function getIndexStateCount(): number {
  const db = getDb();
  return (db.prepare('SELECT COUNT(*) as count FROM search_index_state').get() as { count: number }).count;
}

describe('model change re-index detection', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    teardown(env);
  });

  it('first run with no stored model_uri stores the URI without clearing index state', () => {
    const db = getDb();
    const hash = 'abc123';

    // Simulate existing indexed notes
    insertNote('note-1', hash);
    insertNote('note-2', hash);
    insertIndexState('note-1', hash);
    insertIndexState('note-2', hash);

    // Simulate what the scheduler does: check for stored URI, store new one
    const storedUri = getConfig('model_uri');
    expect(storedUri).toBeUndefined();

    // No stored URI → just store, don't clear
    const modelUri = 'hf:enacimie/Qwen3-Embedding-0.6B-Q4_K_M-GGUF:qwen3-embedding-0.6b-q4_k_m.gguf';
    if (storedUri && storedUri !== modelUri) {
      db.prepare('DELETE FROM search_index_state').run();
    }
    upsertConfig('model_uri', modelUri);

    // Index state should be preserved
    expect(getIndexStateCount()).toBe(2);
    expect(getConfig('model_uri')).toBe(modelUri);
  });

  it('same model_uri on subsequent run preserves index state', () => {
    const hash = 'abc123';
    const modelUri = 'hf:enacimie/Qwen3-Embedding-0.6B-Q4_K_M-GGUF:qwen3-embedding-0.6b-q4_k_m.gguf';

    // Simulate previous run stored the URI
    upsertConfig('model_uri', modelUri);
    insertNote('note-1', hash);
    insertIndexState('note-1', hash);

    // Simulate scheduler check
    const db = getDb();
    const storedUri = getConfig('model_uri');
    expect(storedUri).toBe(modelUri);

    if (storedUri && storedUri !== modelUri) {
      db.prepare('DELETE FROM search_index_state').run();
    }
    upsertConfig('model_uri', modelUri);

    // Index state preserved
    expect(getIndexStateCount()).toBe(1);
  });

  it('changed model_uri clears index state so all notes become dirty', async () => {
    const hash = 'abc123';
    const oldUri = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Qwen3-Embedding-0.6B-Q8_0.gguf';
    const newUri = 'hf:enacimie/Qwen3-Embedding-0.6B-Q4_K_M-GGUF:qwen3-embedding-0.6b-q4_k_m.gguf';

    // Simulate previous run with Q8_0
    upsertConfig('model_uri', oldUri);
    insertNote('note-1', hash);
    insertNote('note-2', hash);
    insertNote('note-3', hash);
    insertIndexState('note-1', hash);
    insertIndexState('note-2', hash);
    insertIndexState('note-3', hash);

    expect(getIndexStateCount()).toBe(3);

    // Simulate scheduler detecting the change
    const db = getDb();
    const storedUri = getConfig('model_uri');
    expect(storedUri).toBe(oldUri);

    if (storedUri && storedUri !== newUri) {
      db.prepare('DELETE FROM search_index_state').run();
    }
    upsertConfig('model_uri', newUri);

    // Index state cleared
    expect(getIndexStateCount()).toBe(0);
    expect(getConfig('model_uri')).toBe(newUri);

    // All notes should now be dirty
    const { getDirtyUuids } = await import('../../src/search/dirtyTracker.js');
    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toHaveLength(3);
    expect(dirty.sort()).toEqual(['note-1', 'note-2', 'note-3']);
  });
});
