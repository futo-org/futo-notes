import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import MiniSearch from 'minisearch';
import { NotePreview, NoteDocument } from '../types';

const sqlite = new SQLiteConnection(CapacitorSQLite);
let db: SQLiteDBConnection | null = null;

const MINISEARCH_OPTIONS = {
  fields: ['noteId', 'content'],
  storeFields: ['noteId', 'content'],
  searchOptions: {
    boost: { noteId: 2 },
    fuzzy: 0.2,
    prefix: true
  }
};

export async function initDB(): Promise<void> {
  const isConn = (await sqlite.isConnection('futo_notes', false)).result;
  db = isConn
    ? await sqlite.retrieveConnection('futo_notes', false)
    : await sqlite.createConnection('futo_notes', false, 'rw', 1, false);

  await db!.open();

  await db!.execute(`
    CREATE TABLE IF NOT EXISTS notes_meta (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      preview TEXT,
      modificationTime INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_index (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mod_time ON notes_meta(modificationTime DESC);
  `);
}

export async function getAllNotes(): Promise<NotePreview[]> {
  if (!db) throw new Error('DB not initialized');
  const result = await db.query('SELECT * FROM notes_meta ORDER BY modificationTime DESC');
  return (result.values || []) as unknown as NotePreview[];
}

export async function upsertNoteMeta(note: NotePreview): Promise<void> {
  if (!db) throw new Error('DB not initialized');
  await db.run(
    `INSERT OR REPLACE INTO notes_meta (id, title, preview, modificationTime) VALUES (?, ?, ?, ?)`,
    [note.id, note.title, note.preview, note.modificationTime]
  );
}

export async function deleteNoteMeta(id: string): Promise<void> {
  if (!db) throw new Error('DB not initialized');
  await db.run('DELETE FROM notes_meta WHERE id = ?', [id]);
}

export async function saveSearchIndex(index: MiniSearch<NoteDocument>): Promise<void> {
  if (!db) throw new Error('DB not initialized');
  const json = JSON.stringify(index.toJSON());
  await db.run('INSERT OR REPLACE INTO search_index (id, data) VALUES (1, ?)', [json]);
}

export async function loadSearchIndex(): Promise<MiniSearch<NoteDocument> | null> {
  if (!db) throw new Error('DB not initialized');
  const result = await db.query('SELECT data FROM search_index WHERE id = 1');
  if (result.values?.length) {
    return MiniSearch.loadJSON(result.values[0].data, MINISEARCH_OPTIONS);
  }
  return null;
}

export function createSearchIndex(): MiniSearch<NoteDocument> {
  return new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);
}
