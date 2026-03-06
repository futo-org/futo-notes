import { Hono } from 'hono';
import { validateTitle, type SyncRequest } from '@futo-notes/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { processSync } from '../sync/engine.js';
import { loadConfig } from '../config.js';
import { broadcastSyncAvailable } from '../events.js';
import { markDirtyAfterSync, removeDirtyForDeleted } from '../search/dirtyTracker.js';
import { log } from '../logger.js';

const sync = new Hono();

sync.post('/sync', authMiddleware, async (c) => {
  let body: SyncRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Validate payload structure
  if (!Array.isArray(body.notes) || !Array.isArray(body.all_uuids) || !Array.isArray(body.deleted_uuids)) {
    log.warn('invalid sync payload: missing required arrays');
    return c.json({ error: 'Invalid sync payload: notes, all_uuids, and deleted_uuids must be arrays' }, 422);
  }

  for (const note of body.notes) {
    if (!note.uuid || !note.filename || typeof note.content_hash !== 'string' || typeof note.hash_at_last_sync !== 'string') {
      log.warn('invalid sync payload: malformed note entry');
      return c.json({ error: 'Invalid sync payload: each note must have uuid, filename, content_hash, and hash_at_last_sync' }, 422);
    }

    if (!note.filename.toLowerCase().endsWith('.md')) {
      log.warn(`invalid sync payload: filename missing .md extension (${note.filename})`);
      return c.json({ error: 'Invalid sync payload: note filenames must end with .md' }, 422);
    }

    const title = note.filename.slice(0, -3);
    const titleIssues = validateTitle(title);
    if (titleIssues.length > 0) {
      const details = titleIssues.map((issue) => issue.kind).join(', ');
      log.warn(`invalid sync payload: invalid note filename (${note.filename}) [${details}]`);
      return c.json({ error: 'Invalid sync payload: note filenames must map directly to valid note titles' }, 422);
    }
  }

  log.info(`sync request: ${body.notes.length} notes, ${body.all_uuids.length} uuids, ${body.deleted_uuids.length} deletions`);

  const db = getDb();
  const config = loadConfig();
  const result = processSync(db, config.notesPath, body);

  // Broadcast only when this request changed server state.
  // Download-only syncs (result.update/result.delete only) should not fan out.
  const mutatedServerState = body.deleted_uuids.length > 0
    || result.hash_updates.length > 0
    || result.conflicts.length > 0;
  if (mutatedServerState) {
    const clientId = c.req.header('X-Client-Id') || '';
    broadcastSyncAvailable(clientId);
  }

  // Search: mark changed notes dirty so they get re-indexed
  if (config.searchEnabled) {
    const changedUuids: string[] = [];
    // Client-to-server changes (hash_updates = notes the server accepted from client)
    for (const hu of result.hash_updates) {
      changedUuids.push(hu.uuid);
    }
    // Server-to-client updates where content changed (another client's edits)
    for (const u of result.update) {
      if (!changedUuids.includes(u.uuid)) {
        changedUuids.push(u.uuid);
      }
    }
    if (changedUuids.length > 0) {
      markDirtyAfterSync(db, changedUuids);
    }
    if (body.deleted_uuids.length > 0) {
      removeDirtyForDeleted(db, body.deleted_uuids);
    }
  }

  return c.json(result);
});

export default sync;
