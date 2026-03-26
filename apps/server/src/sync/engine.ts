import type Database from 'better-sqlite3';
import type { SyncRequest, SyncResponse } from '@futo-notes/shared';
import { extractTags, isImageFilename } from '@futo-notes/shared';
import type { NoteRow } from '../db/notes.js';
import { getAllNotes, upsertNote, deleteNote } from '../db/notes.js';
import { getAllTombstones, createTombstone, pruneTombstones } from '../db/tombstones.js';
import {
  sanitizeFilename,
  writeNoteFile,
  readNoteFile,
  deleteNoteFile,
  readBlobFile,
  sanitizeImageFilename,
} from './files.js';
import { contentHash, binaryContentHash } from './hash.js';
import { getSyncVersion, incrementSyncVersion } from '../db/syncVersion.js';
import { log } from '../logger.js';

// ── In-memory filename resolution (Phase 2) ─────────────

function resolveFilenameInMemory(
  filenameIndex: Map<string, string>,
  sanitized: string,
  uuid: string,
): string {
  const dotIdx = sanitized.lastIndexOf('.');
  const ext = dotIdx >= 0 ? sanitized.slice(dotIdx) : '.md';
  const base = dotIdx >= 0 ? sanitized.slice(0, dotIdx) : sanitized;
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

export function processSync(
  db: Database.Database,
  notesDir: string,
  req: SyncRequest,
): ProcessSyncResult {
  const response: SyncResponse = {
    update: [],
    delete: [],
    hash_updates: [],
    conflicts: [],
  };

  let mutated = false;

  const clientUuidSet = new Set(req.inventory.map((i) => i.uuid));
  const deletedUuidSet = new Set(req.deleted_uuids);

  // Also include UUIDs from notes[] that might not be in inventory
  for (const note of req.notes) {
    clientUuidSet.add(note.uuid);
  }

  let version = 0;

  // Prepared statements for tag indexing — hoisted outside the transaction
  // to avoid recompiling on every call to indexNoteTags
  const deleteTagsStmt = db.prepare('DELETE FROM note_tags WHERE uuid = ?');
  const insertTagStmt = db.prepare('INSERT OR IGNORE INTO note_tags (uuid, tag) VALUES (?, ?)');

  const run = db.transaction(() => {
    // Garbage-collect expired tombstones before loading
    const pruned = pruneTombstones(db);
    if (pruned > 0) {
      log.info(`pruned ${pruned} expired tombstone(s)`);
    }

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

    // Detect reset client: a client where NONE of its UUIDs are known to the server
    // and the server already has notes. This means the client cleared its sync state
    // and is re-uploading with fresh UUIDs. In this case, server is source of truth
    // on filename collisions — don't create (2) duplicates.
    const isResetClient = allNotes.size > 0
      && !req.notes.some((n) => allNotes.has(n.uuid))
      && !req.inventory.some((i) => allNotes.has(i.uuid));

    // Helpers that keep DB + in-memory state in sync
    function trackUpsert(uuid: string, filename: string, hash: string, modifiedAt: number, content?: string, isBlob?: boolean): void {
      const oldNote = allNotes.get(uuid);
      if (oldNote && oldNote.filename !== filename) {
        filenameIndex.delete(oldNote.filename);
      }
      upsertNote(db, uuid, filename, hash, modifiedAt, isBlob);
      allNotes.set(uuid, { uuid, filename, content_hash: hash, modified_at: modifiedAt, created_at: '', is_blob: isBlob ? 1 : 0 });
      filenameIndex.set(filename, uuid);
      mutated = true;
      // Index tags when content is available (skip for blobs)
      if (content !== undefined && !isBlob) {
        indexNoteTags(uuid, content);
      }
    }

    function indexNoteTags(uuid: string, content: string): void {
      const tags = extractTags(content);
      deleteTagsStmt.run(uuid);
      if (tags.length > 0) {
        for (const tag of tags) {
          insertTagStmt.run(uuid, tag.toLowerCase().replace(/^#/, ''));
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
      if (deletedUuidSet.has(clientNote.uuid)) continue;

      // If tombstoned on server, tell client to delete
      if (tombstoneSet.has(clientNote.uuid)) {
        if (!response.delete.includes(clientNote.uuid)) {
          response.delete.push(clientNote.uuid);
        }
        continue;
      }

      const serverNote = allNotes.get(clientNote.uuid);

      if (!serverNote) {
        if (clientNote.is_blob) {
          // Blob: file was pre-uploaded via PUT /sync/blob
          let safeName: string;
          try {
            safeName = sanitizeImageFilename(clientNote.filename);
          } catch {
            log.warn(`skipping blob with invalid filename: ${clientNote.filename}`);
            continue;
          }
          const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);

          // Verify file exists on disk (pre-uploaded)
          const blobData = readBlobFile(notesDir, finalName);
          if (!blobData) {
            log.warn(`blob file missing on disk: ${finalName} (${clientNote.uuid.slice(0, 8)})`);
            continue;
          }
          const hash = binaryContentHash(blobData);

          // Content-aware dedup for blobs
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
              log.debug(`  dedup blob: ${safeName} (${clientNote.uuid.slice(0, 8)} → ${existingUuid.slice(0, 8)})`);
              continue;
            }
          }

          trackUpsert(clientNote.uuid, finalName, hash, clientNote.modified_at, undefined, true);
          response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: hash });
          continue;
        }

        // Original non-blob new note logic
        const safeName = sanitizeFilename(clientNote.filename);
        const content = clientNote.content as string; // Route validates non-blob notes have content
        const hash = contentHash(content);

        // Dedup / reset-client handling: server already has a note with this filename
        const existingUuid = filenameIndex.get(safeName);
        if (existingUuid) {
          const existingNote = allNotes.get(existingUuid);
          if (existingNote && existingNote.content_hash === hash) {
            // Same filename + same content hash → exact duplicate (re-upload after
            // sync state cleared). Tombstone client's UUID, let the server's note be
            // sent back via the server-only-notes path so client adopts original UUID.
            if (!tombstoneSet.has(clientNote.uuid)) {
              createTombstone(db, clientNote.uuid);
              tombstoneSet.add(clientNote.uuid);
              mutated = true;
            }
            response.delete.push(clientNote.uuid);
            log.debug(`  dedup: ${safeName} (${clientNote.uuid.slice(0, 8)} → ${existingUuid.slice(0, 8)})`);
            continue;
          }

          // Same filename but different content. Check if this is a reset client
          // (no reliable sync history) vs a client with real divergent history.
          // A reset client is one where NONE of its UUIDs are known to the server
          // and it has no hash_at_last_sync — i.e. it cleared its sync state entirely.
          if (isResetClient && existingNote) {
            // Reset/reconnect: server is source of truth. Tombstone client's UUID
            // and send the server's version so the client adopts server's UUID+content.
            if (!tombstoneSet.has(clientNote.uuid)) {
              createTombstone(db, clientNote.uuid);
              tombstoneSet.add(clientNote.uuid);
              mutated = true;
            }
            response.delete.push(clientNote.uuid);
            const serverContent = readNoteFile(notesDir, existingNote.filename);
            if (serverContent !== null) {
              response.update.push({
                uuid: existingNote.uuid,
                filename: existingNote.filename,
                modified_at: existingNote.modified_at,
                content_hash: existingNote.content_hash,
                hash_at_last_sync: existingNote.content_hash,
                content: serverContent,
              });
            }
            log.debug(`  reset-dedup: ${safeName} (${clientNote.uuid.slice(0, 8)} → ${existingUuid.slice(0, 8)}, server wins)`);
            continue;
          }
        }

        // No dedup match or client has real sync history — normal collision resolution
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
        if (clientNote.is_blob) {
          // Blobs don't rename, just confirm
          response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: serverHash });
          continue;
        }
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
        if (clientNote.is_blob) {
          let safeName: string;
          try { safeName = sanitizeImageFilename(clientNote.filename); } catch { continue; }
          const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);
          const blobData = readBlobFile(notesDir, finalName);
          if (!blobData) { continue; }
          const hash = binaryContentHash(blobData);
          if (finalName !== serverNote.filename) {
            deleteNoteFile(notesDir, serverNote.filename);
          }
          trackUpsert(clientNote.uuid, finalName, hash, clientNote.modified_at, undefined, true);
          response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: hash });
          continue;
        }
        // Client changed, server unchanged — accept client version
        if (clientNote.content === undefined || clientNote.content === null) {
          // Client claims content changed but didn't send it — skip to avoid data loss.
          // Send the server's current version back so the client can reconcile.
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
          continue;
        }
        const safeName = sanitizeFilename(clientNote.filename);
        const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);
        const content = clientNote.content;
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
        if (serverNote.is_blob) {
          response.update.push({
            uuid: clientNote.uuid,
            filename: serverNote.filename,
            modified_at: serverNote.modified_at,
            content_hash: serverHash,
            hash_at_last_sync: serverHash,
            is_blob: true,
          });
          continue;
        }
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

      // Both changed — but first guard against missing content (same as above).
      if (clientNote.content === undefined || clientNote.content === null) {
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
        continue;
      }

      // Check if both sides converged to the same content.
      // This handles: (a) sync state reset (client re-uploads with hash_at_last_sync='')
      // and (b) two clients independently editing to identical content.
      {
        const cc = clientNote.content;
        const converged = clientNote.content_hash === serverHash
          || contentHash(cc) === serverHash;
        if (converged) {
          response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: serverHash });
          const safeName = sanitizeFilename(clientNote.filename);
          const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);
          if (finalName !== serverNote.filename) {
            if (clientNote.modified_at >= serverNote.modified_at) {
              deleteNoteFile(notesDir, serverNote.filename);
              writeNoteFile(notesDir, finalName, cc, clientNote.modified_at);
              trackUpsert(clientNote.uuid, finalName, serverHash, clientNote.modified_at, cc);
            } else {
              response.update.push({
                uuid: clientNote.uuid,
                filename: serverNote.filename,
                modified_at: serverNote.modified_at,
                content_hash: serverHash,
                hash_at_last_sync: serverHash,
                content: cc,
              });
            }
          }
          continue;
        }
      }

      // Both changed — conflict
      if (clientNote.is_blob) {
        // Images are immutable; last-write-wins
        if (clientNote.modified_at >= serverNote.modified_at) {
          let safeName: string;
          try { safeName = sanitizeImageFilename(clientNote.filename); } catch { continue; }
          const finalName = resolveFilenameInMemory(filenameIndex, safeName, clientNote.uuid);
          const blobData = readBlobFile(notesDir, finalName);
          if (!blobData) { continue; }
          const hash = binaryContentHash(blobData);
          trackUpsert(clientNote.uuid, finalName, hash, clientNote.modified_at, undefined, true);
          response.hash_updates.push({ uuid: clientNote.uuid, hash_at_last_sync: hash });
        } else {
          response.update.push({
            uuid: clientNote.uuid,
            filename: serverNote.filename,
            modified_at: serverNote.modified_at,
            content_hash: serverHash,
            hash_at_last_sync: serverHash,
            is_blob: true,
          });
        }
        continue;
      }

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
      if (serverContent === null) {
        log.warn(`conflict resolution: server file missing for ${serverNote.filename} (${clientNote.uuid.slice(0, 8)}), sending empty content`);
      }
      response.update.push({
        uuid: clientNote.uuid,
        filename: serverNote.filename,
        modified_at: serverNote.modified_at,
        content_hash: serverHash,
        hash_at_last_sync: serverHash,
        content: serverContent ?? '',
      });
    }

    // ── 3b. Process inventory-only entries ────────────────
    for (const item of req.inventory) {
      // Skip if already processed as a note with content
      if (notesUuidSet.has(item.uuid)) continue;
      // Skip if in deleted_uuids
      if (deletedUuidSet.has(item.uuid)) continue;
      // Skip if tombstoned (already handled in section 2)
      if (tombstoneSet.has(item.uuid)) continue;

      const serverNote = allNotes.get(item.uuid);
      if (!serverNote) continue; // Client has it, server doesn't — skip

      if (serverNote.content_hash !== item.content_hash) {
        if (serverNote.is_blob) {
          response.update.push({
            uuid: serverNote.uuid,
            filename: serverNote.filename,
            modified_at: serverNote.modified_at,
            content_hash: serverNote.content_hash,
            hash_at_last_sync: serverNote.content_hash,
            is_blob: true,
          });
          continue;
        }
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
          // Skip rename logic for blobs (machine-generated filenames don't rename)
          if (isImageFilename(item.filename)) {
            continue;
          }
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

    // ── 4. Server-only notes ─────────────────────────────
    for (const [uuid, serverNote] of allNotes) {
      if (clientUuidSet.has(uuid)) continue;
      if (deletedUuidSet.has(uuid)) continue;

      if (serverNote.is_blob) {
        response.update.push({
          uuid: serverNote.uuid,
          filename: serverNote.filename,
          modified_at: serverNote.modified_at,
          content_hash: serverNote.content_hash,
          hash_at_last_sync: serverNote.content_hash,
          is_blob: true,
        });
        continue;
      }

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
    `SYNC v${version} ↑${response.update.length} downloaded, ↓${req.notes.filter((n) => !deletedUuidSet.has(n.uuid)).length} received, ✗${response.conflicts.length} conflicts, 🗑${response.delete.length} deleted`,
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
