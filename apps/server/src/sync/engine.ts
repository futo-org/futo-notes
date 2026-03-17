import type Database from 'better-sqlite3';
import type { SyncRequest, SyncResponse, InventoryItem } from '@futo-notes/shared';
import { extractTags } from '@futo-notes/shared';
import type { NoteRow } from '../db/notes.js';
import { getAllNotes, upsertNote, deleteNote } from '../db/notes.js';
import { getAllTombstones, createTombstone } from '../db/tombstones.js';
import {
  sanitizeFilename,
  writeNoteFile,
  readNoteFile,
  deleteNoteFile,
} from './files.js';
import { contentHash } from './hash.js';
import { getSyncVersion, incrementSyncVersion } from '../db/syncVersion.js';
import { log } from '../logger.js';

// ── In-memory filename resolution (Phase 2) ─────────────

function resolveFilenameInMemory(
  filenameIndex: Map<string, string>,
  sanitized: string,
  uuid: string,
): string {
  const ext = '.md';
  const base = sanitized.slice(0, -ext.length);
  let candidate = sanitized;
  let counter = 1;
  while (true) {
    const existing = filenameIndex.get(candidate);
    if (!existing || existing === uuid) break;
    counter++;
    candidate = `${base} (${counter})${ext}`;
  }
  return candidate;
}

function conflictFilenameInMemory(
  filenameIndex: Map<string, string>,
  originalFilename: string,
  uuid: string,
): string {
  const ext = '.md';
  const base = originalFilename.endsWith(ext)
    ? originalFilename.slice(0, -ext.length)
    : originalFilename;
  const date = new Date().toISOString().split('T')[0];
  let candidate = `${base} (conflict ${date})${ext}`;
  let counter = 1;
  while (filenameIndex.has(candidate) && filenameIndex.get(candidate) !== uuid) {
    counter++;
    candidate = `${base} (conflict ${date} ${counter})${ext}`;
  }
  return candidate;
}

// ── Sync engine ──────────────────────────────────────────

export interface ProcessSyncResult {
  response: SyncResponse;
  version: number;
}

/**
 * Process a sync request. Supports both V1 (all_uuids) and V2 (inventory) formats.
 * Pass `inventory` for V2 requests; omit for V1.
 */
export function processSync(
  db: Database.Database,
  notesDir: string,
  req: SyncRequest,
  inventory?: InventoryItem[],
): ProcessSyncResult {
  const response: SyncResponse = {
    update: [],
    delete: [],
    hash_updates: [],
    conflicts: [],
  };

  let mutated = false;

  // Build client UUID set from inventory (V2) or all_uuids (V1)
  const clientUuidSet = inventory
    ? new Set(inventory.map((i) => i.uuid))
    : new Set(req.all_uuids);

  // Also include UUIDs from notes[] that might not be in all_uuids/inventory
  for (const note of req.notes) {
    clientUuidSet.add(note.uuid);
  }

  let version = 0;

  const run = db.transaction(() => {
    // Phase 2: Bulk load everything into memory (2 queries instead of ~6000)
    const allNotes = new Map<string, NoteRow>(
      getAllNotes(db).map((n) => [n.uuid, n]),
    );
    const tombstoneSet = new Set(
      getAllTombstones(db).map((t) => t.uuid),
    );

    // Build filename→uuid index for in-memory collision detection
    const filenameIndex = new Map<string, string>();
    for (const [uuid, note] of allNotes) {
      filenameIndex.set(note.filename, uuid);
    }

    // Helpers that keep DB + in-memory state in sync
    function trackUpsert(uuid: string, filename: string, hash: string, modifiedAt: number, content?: string): void {
      const oldNote = allNotes.get(uuid);
      if (oldNote && oldNote.filename !== filename) {
        filenameIndex.delete(oldNote.filename);
      }
      upsertNote(db, uuid, filename, hash, modifiedAt);
      allNotes.set(uuid, { uuid, filename, content_hash: hash, modified_at: modifiedAt, created_at: '' });
      filenameIndex.set(filename, uuid);
      mutated = true;
      // Index tags when content is available
      if (content !== undefined) {
        indexNoteTags(uuid, content);
      }
    }

    function indexNoteTags(uuid: string, content: string): void {
      const tags = extractTags(content);
      db.prepare('DELETE FROM note_tags WHERE uuid = ?').run(uuid);
      if (tags.length > 0) {
        const insert = db.prepare('INSERT OR IGNORE INTO note_tags (uuid, tag) VALUES (?, ?)');
        for (const tag of tags) {
          insert.run(uuid, tag.toLowerCase().replace(/^#/, ''));
        }
      }
    }

    function trackDelete(uuid: string): void {
      const note = allNotes.get(uuid);
      if (note) {
        filenameIndex.delete(note.filename);
        allNotes.delete(uuid);
      }
      deleteNote(db, uuid);
      mutated = true;
    }

    // ── 1. Process client deletions ───────────────────────
    for (const uuid of req.deleted_uuids) {
      const existing = allNotes.get(uuid);
      if (existing) {
        deleteNoteFile(notesDir, existing.filename);
        trackDelete(uuid);
      }
      if (!tombstoneSet.has(uuid)) {
        createTombstone(db, uuid);
        tombstoneSet.add(uuid);
        mutated = true;
      }
    }

    // ── 2. Propagate server deletions ────────────────────
    for (const uuid of tombstoneSet) {
      if (clientUuidSet.has(uuid)) {
        response.delete.push(uuid);
      }
    }

    // ── 3. Process client notes (with full metadata) ─────
    const notesUuidSet = new Set(req.notes.map((n) => n.uuid));

    for (const clientNote of req.notes) {
      // Skip if we just tombstoned it
      if (req.deleted_uuids.includes(clientNote.uuid)) continue;

      // If tombstoned on server, tell client to delete
      if (tombstoneSet.has(clientNote.uuid)) {
        if (!response.delete.includes(clientNote.uuid)) {
          response.delete.push(clientNote.uuid);
        }
        continue;
      }

      const serverNote = allNotes.get(clientNote.uuid);

      if (!serverNote) {
        const safeName = sanitizeFilename(clientNote.filename);
        const content = clientNote.content ?? '';
        const hash = contentHash(content);

        // Content-aware dedup: if an existing note has the same filename AND
        // content hash, this is a re-upload after sync state was cleared (e.g.
        // server change or reset). Don't create a "(2)" duplicate — tombstone
        // the client's new UUID and let the existing note be sent back via the
        // server-only-notes path so the client adopts the original UUID.
        const existingUuid = filenameIndex.get(safeName);
        if (existingUuid) {
          const existingNote = allNotes.get(existingUuid);
          if (existingNote && existingNote.content_hash === hash) {
            if (!tombstoneSet.has(clientNote.uuid)) {
              createTombstone(db, clientNote.uuid);
              tombstoneSet.add(clientNote.uuid);
              mutated = true;
            }
            response.delete.push(clientNote.uuid);
            log.debug(`  dedup: ${safeName} (${clientNote.uuid.slice(0, 8)} → ${existingUuid.slice(0, 8)})`);
            continue;
          }
        }

        // No dedup match — normal collision resolution
        const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);
        writeNoteFile(notesDir, finalName, content, clientNote.modified_at);
        trackUpsert(clientNote.uuid, finalName, hash, clientNote.modified_at, content);
        response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: hash });
        continue;
      }

      const serverHash = serverNote.content_hash;
      const clientHash = clientNote.content_hash;
      const lastSync = clientNote.hash_at_last_sync;

      if (clientHash === lastSync && serverHash === lastSync) {
        // No changes on either side — but check for filename changes
        const safeName = sanitizeFilename(clientNote.filename);
        const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);
        if (finalName !== serverNote.filename) {
          if (clientNote.modified_at >= serverNote.modified_at) {
            // Client renamed more recently — accept client's filename
            const content = readNoteFile(notesDir, serverNote.filename) ?? '';
            deleteNoteFile(notesDir, serverNote.filename);
            writeNoteFile(notesDir, finalName, content, clientNote.modified_at);
            trackUpsert(clientNote.uuid, finalName, serverHash, clientNote.modified_at, content);
            response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: serverHash });
          } else {
            // Server's filename is newer — send to this client
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
        const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);
        const content = clientNote.content ?? '';
        const hash = contentHash(content);

        // Clean up old file if filename changed
        if (finalName !== serverNote.filename) {
          deleteNoteFile(notesDir, serverNote.filename);
        }
        writeNoteFile(notesDir, finalName, content, clientNote.modified_at);
        trackUpsert(clientNote.uuid, finalName, hash, clientNote.modified_at, content);
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
      const conflictName = conflictFilenameInMemory(filenameIndex, clientNote.filename, clientNote.uuid);
      const clientContent = clientNote.content ?? '';
      const conflictModifiedAt = Date.now();
      writeNoteFile(notesDir, conflictName, clientContent, conflictModifiedAt);

      // Create a new note entry for the conflict copy
      const conflictUuid = crypto.randomUUID();
      const conflictHash = contentHash(clientContent);
      trackUpsert(conflictUuid, conflictName, conflictHash, conflictModifiedAt, clientContent);

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

    // ── 3b. Process inventory-only entries (V2) ──────────
    if (inventory) {
      for (const item of inventory) {
        // Skip if already processed as a note with content
        if (notesUuidSet.has(item.uuid)) continue;
        // Skip if in deleted_uuids
        if (req.deleted_uuids.includes(item.uuid)) continue;
        // Skip if tombstoned (already handled in section 2)
        if (tombstoneSet.has(item.uuid)) continue;

        const serverNote = allNotes.get(item.uuid);
        if (!serverNote) continue; // Client has it, server doesn't — skip

        if (serverNote.content_hash !== item.content_hash) {
          // Server changed, client unchanged → send server version
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
        } else {
          // Hashes match — check for filename rename
          const safeName = sanitizeFilename(item.filename);
          const finalName = resolveFilenameInMemory(filenameIndex, safeName, item.uuid);
          if (finalName !== serverNote.filename) {
            if (item.modified_at >= serverNote.modified_at) {
              // Client renamed more recently — accept client's filename
              const content = readNoteFile(notesDir, serverNote.filename) ?? '';
              deleteNoteFile(notesDir, serverNote.filename);
              writeNoteFile(notesDir, finalName, content, item.modified_at);
              trackUpsert(item.uuid, finalName, serverNote.content_hash, item.modified_at, content);
              response.hash_updates.push({ uuid: item.uuid, hash_at_last_sync: serverNote.content_hash });
            } else {
              // Server's filename is newer — send to client
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
          }
        }
      }
    }

    // ── 4. Server-only notes ─────────────────────────────
    const deletedUuids = new Set(req.deleted_uuids);

    for (const [uuid, serverNote] of allNotes) {
      if (clientUuidSet.has(uuid)) continue;
      if (deletedUuids.has(uuid)) continue;

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

    // Phase 1: Version tracking
    if (mutated) {
      version = incrementSyncVersion(db);
    } else {
      version = getSyncVersion(db);
    }
  });

  run();

  log.info(
    `SYNC v${version} ↑${response.update.length} downloaded, ↓${req.notes.filter((n) => !req.deleted_uuids.includes(n.uuid)).length} received, ✗${response.conflicts.length} conflicts, 🗑${response.delete.length} deleted`,
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

  return { response, version };
}
