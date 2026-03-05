import type Database from 'better-sqlite3';
import type { NoteSyncMeta, SyncRequest, SyncResponse } from '@futo-notes/shared';
import { getNote, getAllNotes, upsertNote, deleteNote } from '../db/notes.js';
import { getTombstone, createTombstone, getAllTombstones } from '../db/tombstones.js';
import {
  sanitizeFilename,
  resolveFilename,
  conflictFilename,
  writeNoteFile,
  readNoteFile,
  deleteNoteFile,
} from './files.js';
import { contentHash } from './hash.js';
import { log } from '../logger.js';

export function processSync(
  db: Database.Database,
  notesDir: string,
  req: SyncRequest,
): SyncResponse {
  const response: SyncResponse = {
    update: [],
    delete: [],
    hash_updates: [],
    conflicts: [],
  };

  const clientUuidSet = new Set(req.all_uuids);

  // Everything runs in a transaction
  const run = db.transaction(() => {
    // ── 1. Process client deletions ───────────────────────
    for (const uuid of req.deleted_uuids) {
      const existing = getNote(db, uuid);
      if (existing) {
        deleteNoteFile(notesDir, existing.filename);
        deleteNote(db, uuid);
      }
      createTombstone(db, uuid);
    }

    // ── 2. Propagate server deletions ────────────────────
    const tombstones = getAllTombstones(db);
    for (const ts of tombstones) {
      if (clientUuidSet.has(ts.uuid)) {
        response.delete.push(ts.uuid);
      }
    }

    // ── 3. Process each client note ──────────────────────
    for (const clientNote of req.notes) {
      // Skip if we just tombstoned it
      if (req.deleted_uuids.includes(clientNote.uuid)) continue;

      // If tombstoned on server, tell client to delete
      if (getTombstone(db, clientNote.uuid)) {
        if (!response.delete.includes(clientNote.uuid)) {
          response.delete.push(clientNote.uuid);
        }
        continue;
      }

      const serverNote = getNote(db, clientNote.uuid);

      if (!serverNote) {
        // New note from client — store it
        const safeName = sanitizeFilename(clientNote.filename);
        const finalName = resolveFilename(db, safeName, clientNote.uuid);
        const content = clientNote.content ?? '';
        const hash = contentHash(content);

        writeNoteFile(notesDir, finalName, content, clientNote.modified_at);
        upsertNote(db, clientNote.uuid, finalName, hash, clientNote.modified_at);
        response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: hash });
        continue;
      }

      const serverHash = serverNote.content_hash;
      const clientHash = clientNote.content_hash;
      const lastSync = clientNote.hash_at_last_sync;

      if (clientHash === lastSync && serverHash === lastSync) {
        // No changes on either side — but check for filename changes
        const safeName = sanitizeFilename(clientNote.filename);
        const finalName = resolveFilename(db, safeName, clientNote.uuid);
        if (finalName !== serverNote.filename) {
          if (clientNote.modified_at >= serverNote.modified_at) {
            // Client renamed more recently — accept client's filename
            const content = readNoteFile(notesDir, serverNote.filename) ?? '';
            deleteNoteFile(notesDir, serverNote.filename);
            writeNoteFile(notesDir, finalName, content, clientNote.modified_at);
            upsertNote(db, clientNote.uuid, finalName, serverHash, clientNote.modified_at);
            response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: serverHash });
          } else {
            // Server's filename is newer (from another client's rename) — send to this client
            const content = readNoteFile(notesDir, serverNote.filename);
            if (content !== null) {
              response.update.push({
                uuid: clientNote.uuid,
                filename: serverNote.filename,
                modified_at: serverNote.modified_at,
                content_hash: serverHash,
                hash_at_last_sync: serverHash,
                content,
              });
            }
          }
        }
        continue;
      }

      if (clientHash !== lastSync && serverHash === lastSync) {
        // Client changed, server unchanged — accept client version
        const safeName = sanitizeFilename(clientNote.filename);
        const finalName = resolveFilename(db, safeName, clientNote.uuid);
        const content = clientNote.content ?? '';
        const hash = contentHash(content);

        // Clean up old file if filename changed
        if (finalName !== serverNote.filename) {
          deleteNoteFile(notesDir, serverNote.filename);
        }
        writeNoteFile(notesDir, finalName, content, clientNote.modified_at);
        upsertNote(db, clientNote.uuid, finalName, hash, clientNote.modified_at);
        response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: hash });
        continue;
      }

      if (clientHash === lastSync && serverHash !== lastSync) {
        // Server changed, client unchanged — send server version
        const content = readNoteFile(notesDir, serverNote.filename);
        if (content !== null) {
          response.update.push({
            uuid: clientNote.uuid,
            filename: serverNote.filename,
            modified_at: serverNote.modified_at,
            content_hash: serverHash,
            hash_at_last_sync: serverHash,
            content,
          });
        }
        continue;
      }

      // Both changed — conflict
      // Server keeps its version. Save client's version as a conflict copy.
      const conflictName = conflictFilename(db, clientNote.filename, clientNote.uuid);
      const clientContent = clientNote.content ?? '';
      const conflictModifiedAt = Date.now();
      writeNoteFile(notesDir, conflictName, clientContent, conflictModifiedAt);

      // Create a new note entry for the conflict copy
      const conflictUuid = crypto.randomUUID();
      const conflictHash = contentHash(clientContent);
      upsertNote(db, conflictUuid, conflictName, conflictHash, conflictModifiedAt);

      response.conflicts.push({
        uuid: clientNote.uuid,
        server_filename: serverNote.filename,
        client_filename: conflictName,
        client_content: clientContent,
      });

      // Send server version to client
      const serverContent = readNoteFile(notesDir, serverNote.filename);
      if (serverContent !== null) {
        response.update.push({
          uuid: clientNote.uuid,
          filename: serverNote.filename,
          modified_at: serverNote.modified_at,
          content_hash: serverHash,
          hash_at_last_sync: serverHash,
          content: serverContent,
        });
      }
    }

    // ── 4. Server-only notes ─────────────────────────────
    const allServerNotes = getAllNotes(db);
    const deletedUuids = new Set(req.deleted_uuids);

    for (const serverNote of allServerNotes) {
      if (clientUuidSet.has(serverNote.uuid)) continue;
      if (deletedUuids.has(serverNote.uuid)) continue;

      const content = readNoteFile(notesDir, serverNote.filename);
      if (content !== null) {
        response.update.push({
          uuid: serverNote.uuid,
          filename: serverNote.filename,
          modified_at: serverNote.modified_at,
          content_hash: serverNote.content_hash,
          hash_at_last_sync: serverNote.content_hash,
          content,
        });
      }
    }
  });

  run();

  log.info(
    `SYNC ↑${response.update.length} downloaded, ↓${req.notes.filter((n) => !req.deleted_uuids.includes(n.uuid)).length} received, ✗${response.conflicts.length} conflicts, 🗑${response.delete.length} deleted`,
  );

  for (const u of response.update) {
    log.debug(`  ↓ ${u.filename} (${u.uuid.slice(0, 8)})`);
  }
  for (const d of response.delete) {
    log.debug(`  🗑 ${d.slice(0, 8)}`);
  }
  for (const conflict of response.conflicts) {
    log.debug(`  ✗ conflict: ${conflict.server_filename} vs ${conflict.client_filename}`);
  }

  return response;
}
