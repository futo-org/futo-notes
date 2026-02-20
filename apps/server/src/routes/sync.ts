import { Hono } from 'hono';
import type { SyncRequest } from '@futo-notes/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { processSync } from '../sync/engine.js';
import { loadConfig } from '../config.js';
import { broadcastSyncAvailable } from '../events.js';
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
  }

  log.info(`sync request: ${body.notes.length} notes, ${body.all_uuids.length} uuids, ${body.deleted_uuids.length} deletions`);

  const db = getDb();
  const config = loadConfig();
  const result = processSync(db, config.notesPath, body);

  const hasChanges = result.update.length > 0 || result.delete.length > 0
    || result.conflicts.length > 0 || result.hash_updates.length > 0;
  if (hasChanges) {
    const clientId = c.req.header('X-Client-Id') || '';
    broadcastSyncAvailable(clientId);
  }

  return c.json(result);
});

export default sync;
