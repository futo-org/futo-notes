import { Hono } from 'hono';
import type { SyncRequest } from '@futo-notes/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { processSync } from '../sync/engine.js';
import { loadConfig } from '../config.js';

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
    return c.json({ error: 'Invalid sync payload: notes, all_uuids, and deleted_uuids must be arrays' }, 422);
  }

  for (const note of body.notes) {
    if (!note.uuid || !note.filename || typeof note.content_hash !== 'string' || typeof note.hash_at_last_sync !== 'string') {
      return c.json({ error: 'Invalid sync payload: each note must have uuid, filename, content_hash, and hash_at_last_sync' }, 422);
    }
  }

  const db = getDb();
  const config = loadConfig();
  const result = processSync(db, config.notesPath, body);
  return c.json(result);
});

export default sync;
