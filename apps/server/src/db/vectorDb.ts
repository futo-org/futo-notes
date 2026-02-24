import type Database from 'better-sqlite3';
import { log } from '../logger.js';

let initialized = false;

/**
 * Initialize the vector DB by loading the sqlite-vec extension
 * and creating the search_vectors virtual table.
 * Uses dynamic import so sqlite-vec is only loaded when SEARCH_ENABLED=true.
 */
export async function initVectorDb(db: Database.Database, dims: number): Promise<void> {
  if (initialized) return;

  // Dynamic import
  const sqliteVec = await import('sqlite-vec');
  sqliteVec.load(db);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_vectors USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${dims}] distance_metric=cosine
    );
  `);

  initialized = true;
  log.info(`search: vector DB initialized (dims=${dims})`);
}

/**
 * Insert a vector for a chunk.
 */
export function insertVector(
  db: Database.Database,
  chunkId: number | bigint,
  embedding: number[],
): void {
  const buf = new Float32Array(embedding);
  // sqlite-vec requires INTEGER binding; JS number binds as REAL in better-sqlite3
  db.prepare('INSERT INTO search_vectors (chunk_id, embedding) VALUES (?, ?)')
    .run(BigInt(chunkId), Buffer.from(buf.buffer));
}

/**
 * Delete all vectors for a given note UUID by looking up chunk IDs.
 */
export function deleteVectorsForUuid(db: Database.Database, uuid: string): void {
  const chunks = db.prepare('SELECT chunk_id FROM search_chunks WHERE uuid = ?')
    .all(uuid) as { chunk_id: number }[];

  if (chunks.length === 0) return;

  const del = db.prepare('DELETE FROM search_vectors WHERE chunk_id = ?');
  const run = db.transaction(() => {
    for (const chunk of chunks) {
      del.run(BigInt(chunk.chunk_id));
    }
  });
  run();
}

/**
 * Search for nearest neighbors.
 * Returns chunk IDs sorted by distance (ascending = most similar).
 */
export function searchVectors(
  db: Database.Database,
  queryVector: number[],
  topK: number,
): { chunk_id: bigint; distance: number }[] {
  const buf = new Float32Array(queryVector);
  return db.prepare(`
    SELECT chunk_id, distance FROM search_vectors
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(Buffer.from(buf.buffer), topK) as { chunk_id: bigint; distance: number }[];
}

/**
 * Reset initialized state (for testing).
 */
export function resetVectorDb(): void {
  initialized = false;
}
