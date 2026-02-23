import type Database from 'better-sqlite3';
import { getNote } from '../db/notes.js';
import { readNoteFile } from '../sync/files.js';
import { chunkContent } from './chunker.js';
import { insertVector, deleteVectorsForUuid } from '../db/vectorDb.js';
import type { EmbeddingModel } from './modelManager.js';
import { contentHash } from '../sync/hash.js';
import { log } from '../logger.js';

/**
 * Create a level-2 batch processor for the job runner.
 * Reads note content, chunks it, embeds it, and stores vectors.
 */
export function createEmbeddingProcessor(
  model: EmbeddingModel,
  notesPath: string,
): (db: Database.Database, uuids: string[]) => Promise<void> {
  return async (db: Database.Database, uuids: string[]) => {
    for (const uuid of uuids) {
      const note = getNote(db, uuid);
      if (!note) {
        log.debug(`search: skipping deleted note ${uuid.slice(0, 8)}`);
        continue;
      }

      const content = readNoteFile(notesPath, note.filename);
      if (content === null) {
        log.warn(`search: file missing for ${uuid.slice(0, 8)} (${note.filename})`);
        continue;
      }

      // Delete existing chunks and vectors
      deleteVectorsForUuid(db, uuid);
      db.prepare('DELETE FROM search_chunks WHERE uuid = ?').run(uuid);

      // Chunk the content
      const chunks = chunkContent(content);
      if (chunks.length === 0) {
        log.debug(`search: no chunks for ${uuid.slice(0, 8)} (empty content)`);
        continue;
      }

      // Extract texts for batch embedding
      const texts = chunks.map((c) => c.text);
      const embeddings = await model.embed(texts);

      // Insert chunks and vectors
      const hash = contentHash(content);
      const insertChunk = db.prepare(`
        INSERT INTO search_chunks (uuid, chunk_index, chunk_text, start_offset, end_offset, content_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const insertAll = db.transaction(() => {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const result = insertChunk.run(uuid, i, chunk.text, chunk.startOffset, chunk.endOffset, hash);
          const chunkId = Number(result.lastInsertRowid);
          insertVector(db, chunkId, embeddings[i]);
        }

        // Update index state
        db.prepare(`
          INSERT INTO search_index_state (uuid, level, content_hash, indexed_at)
          VALUES (?, 2, ?, ?)
          ON CONFLICT(uuid, level) DO UPDATE SET
            content_hash = excluded.content_hash,
            indexed_at = excluded.indexed_at
        `).run(uuid, hash, Date.now());
      });
      insertAll();

      log.debug(`search: indexed ${uuid.slice(0, 8)} (${chunks.length} chunks)`);
    }
  };
}
