import type Database from 'better-sqlite3';
import { log } from '../logger.js';
import { deleteVectorsForUuid } from '../db/vectorDb.js';

/**
 * Reset search_index_state rows for changed UUIDs so content_hash
 * mismatches trigger re-indexing on the next job run.
 */
export function markDirtyAfterSync(db: Database.Database, changedUuids: string[]): void {
  if (changedUuids.length === 0) return;

  const del = db.prepare('DELETE FROM search_index_state WHERE uuid = ?');
  const run = db.transaction(() => {
    for (const uuid of changedUuids) {
      del.run(uuid);
    }
  });
  run();
  log.debug(`search: marked ${changedUuids.length} note(s) dirty`);
}

/**
 * Return UUIDs that need (re-)indexing at the given level.
 * A note is dirty if its content_hash in `notes` differs from
 * the hash in search_index_state, or if no state row exists.
 */
export function getDirtyUuids(db: Database.Database, level: number): string[] {
  const rows = db.prepare(`
    SELECT n.uuid FROM notes n
    LEFT JOIN search_index_state s ON s.uuid = n.uuid AND s.level = ?
    WHERE s.uuid IS NULL OR s.content_hash != n.content_hash
  `).all(level) as { uuid: string }[];
  return rows.map((r) => r.uuid);
}

/**
 * Clean up search_index_state and search_chunks for deleted notes.
 */
export function removeDirtyForDeleted(db: Database.Database, deletedUuids: string[]): void {
  if (deletedUuids.length === 0) return;

  const delState = db.prepare('DELETE FROM search_index_state WHERE uuid = ?');
  const delChunks = db.prepare('DELETE FROM search_chunks WHERE uuid = ?');
  const run = db.transaction(() => {
    for (const uuid of deletedUuids) {
      deleteVectorsForUuid(db, uuid);
      delState.run(uuid);
      delChunks.run(uuid);
    }
  });
  run();
  log.debug(`search: cleaned up state for ${deletedUuids.length} deleted note(s)`);
}
