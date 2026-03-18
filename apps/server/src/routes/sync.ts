import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { validateTitle, type SyncRequest, type SyncCheckRequest } from '@futo-notes/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { processSync } from '../sync/engine.js';
import { getSyncVersion } from '../db/syncVersion.js';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';
import { applyNoteMutationEffects } from '../sync/noteMutationEffects.js';

const MAX_BODY_SIZE = 500 * 1024 * 1024; // 500 MB

const sync = new Hono();

// ── Quick-check endpoint (Phase 1) ──────────────────────

sync.post('/sync/check', authMiddleware, async (c) => {
  let body: SyncCheckRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (typeof body.version !== 'number') {
    return c.json({ error: 'version must be a number' }, 422);
  }

  const db = getDb();
  const currentVersion = getSyncVersion(db);
  const status = body.version === currentVersion ? 'up_to_date' : 'changes_available';

  return c.json({ status, version: currentVersion });
});

// ── Main sync endpoint ───────────────────────────────────

sync.post('/sync', bodyLimit({ maxSize: MAX_BODY_SIZE, onError: (c) => c.json({ error: `Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024} MB)` }, 413) }), authMiddleware, async (c) => {
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const body = rawBody as unknown as SyncRequest;

  if (!Array.isArray(body.notes) || !Array.isArray(body.inventory) || !Array.isArray(body.deleted_uuids)) {
    log.warn('invalid sync payload: missing required arrays');
    return c.json({ error: 'Invalid sync payload: notes, inventory, and deleted_uuids must be arrays' }, 422);
  }

  for (const item of body.inventory) {
    if (!item.uuid || typeof item.content_hash !== 'string' || !item.filename) {
      log.warn('invalid sync payload: malformed inventory entry');
      return c.json({ error: 'Invalid sync payload: each inventory item must have uuid, content_hash, and filename' }, 422);
    }
    if (typeof item.modified_at !== 'number' || !Number.isFinite(item.modified_at) || item.modified_at < 0) {
      log.warn(`invalid sync payload: invalid modified_at in inventory (${item.uuid})`);
      return c.json({ error: 'Invalid sync payload: inventory modified_at must be a finite non-negative number' }, 400);
    }
    if (!item.filename.toLowerCase().endsWith('.md')) {
      log.warn(`invalid sync payload: inventory filename missing .md extension (${item.filename})`);
      return c.json({ error: 'Invalid sync payload: inventory filenames must end with .md' }, 422);
    }
    const invTitle = item.filename.slice(0, -3);
    const invTitleIssues = validateTitle(invTitle);
    if (invTitleIssues.length > 0) {
      const details = invTitleIssues.map((issue) => issue.kind).join(', ');
      log.warn(`invalid sync payload: invalid inventory filename (${item.filename}) [${details}]`);
      return c.json({ error: 'Invalid sync payload: inventory filenames must map directly to valid note titles' }, 422);
    }
  }

  // Validate notes entries
  for (const note of body.notes) {
    if (!note.uuid || !note.filename || typeof note.content_hash !== 'string' || typeof note.hash_at_last_sync !== 'string') {
      log.warn('invalid sync payload: malformed note entry');
      return c.json({ error: 'Invalid sync payload: each note must have uuid, filename, content_hash, and hash_at_last_sync' }, 422);
    }
    if (typeof note.modified_at !== 'number' || !Number.isFinite(note.modified_at) || note.modified_at < 0) {
      log.warn(`invalid sync payload: invalid modified_at in note (${note.uuid})`);
      return c.json({ error: 'Invalid sync payload: note modified_at must be a finite non-negative number' }, 400);
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

  log.info(`sync request: ${body.notes.length} changed notes, ${body.inventory.length} inventory, ${body.deleted_uuids.length} deletions`);

  const db = getDb();
  const config = loadConfig();
  const { response: result, version } = processSync(db, config.notesPath, body);
  result.version = version;

  handlePostSync(c, result, body, config);
  return c.json(result);
});

/** Shared post-sync logic: SSE broadcast + search dirty tracking. */
function handlePostSync(
  c: { req: { header: (name: string) => string | undefined } },
  result: import('@futo-notes/shared').SyncResponse,
  body: SyncRequest,
  config: ReturnType<typeof loadConfig>,
): void {
  // Broadcast only when this request changed server state
  const mutatedServerState = body.deleted_uuids.length > 0
    || result.hash_updates.length > 0
    || result.conflicts.length > 0;
  const changedUuids = [
    ...result.hash_updates.map((update) => update.uuid),
    ...result.update.map((update) => update.uuid),
  ];
  applyNoteMutationEffects(getDb(), {
    changedUuids,
    deletedUuids: body.deleted_uuids,
    notifyClients: mutatedServerState,
    excludeClientId: c.req.header('X-Client-Id'),
    incrementVersion: false,
    searchEnabled: config.searchEnabled,
  });
}

export default sync;
