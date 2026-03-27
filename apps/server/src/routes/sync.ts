import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { validateTitle, isImageFilename, type SyncRequest, type SyncCheckRequest } from '@futo-notes/shared';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { processSync } from '../sync/engine.js';
import { getSyncVersion } from '../db/syncVersion.js';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';
import { applyNoteMutationEffects } from '../sync/noteMutationEffects.js';
import { triggerIndexAfterSync } from '../search/scheduler.js';
import { checkPostSyncInvariants } from '../sync/invariants.js';
import { isRecordingEnabled, recordSnapshot, dumpFailingSnapshot } from '../sync/recording.js';

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

  // Validate deleted_uuids entries are all strings
  for (const uuid of body.deleted_uuids) {
    if (typeof uuid !== 'string') {
      log.warn('invalid sync payload: non-string in deleted_uuids');
      return c.json({ error: 'Invalid sync payload: each deleted_uuids entry must be a string' }, 422);
    }
  }

  // Build UUID sets for duplicate / cross-array detection
  const noteUuids = new Set<string>();
  const deletedUuidSet = new Set(body.deleted_uuids);

  for (const item of body.inventory) {
    if (typeof item.uuid !== 'string' || typeof item.content_hash !== 'string' || typeof item.filename !== 'string') {
      log.warn('invalid sync payload: malformed inventory entry');
      return c.json({ error: 'Invalid sync payload: each inventory item must have uuid, content_hash, and filename as strings' }, 422);
    }
    if (!item.uuid || !item.content_hash || !item.filename) {
      log.warn('invalid sync payload: empty string in inventory entry');
      return c.json({ error: 'Invalid sync payload: inventory uuid, content_hash, and filename must be non-empty' }, 422);
    }
    if (item.content_hash.length > 128) {
      log.warn(`invalid sync payload: inventory content_hash too long (${item.uuid})`);
      return c.json({ error: 'Invalid sync payload: content_hash exceeds maximum length' }, 422);
    }
    if (typeof item.modified_at !== 'number' || !Number.isFinite(item.modified_at) || item.modified_at < 0) {
      log.warn(`invalid sync payload: invalid modified_at in inventory (${item.uuid})`);
      return c.json({ error: 'Invalid sync payload: inventory modified_at must be a finite non-negative number' }, 400);
    }
    if (!item.filename.toLowerCase().endsWith('.md')) {
      if (!isImageFilename(item.filename)) {
        log.warn(`invalid sync payload: inventory filename has unsupported extension (${item.filename})`);
        return c.json({ error: 'Invalid sync payload: inventory filenames must end with .md or be a valid image file' }, 422);
      }
      // Image filenames skip title validation (machine-generated names)
    } else {
      const invTitle = item.filename.slice(0, -3);
      const invTitleIssues = validateTitle(invTitle);
      if (invTitleIssues.length > 0) {
        const details = invTitleIssues.map((issue) => issue.kind).join(', ');
        log.warn(`invalid sync payload: invalid inventory filename (${item.filename}) [${details}]`);
        return c.json({ error: 'Invalid sync payload: inventory filenames must map directly to valid note titles' }, 422);
      }
    }
  }

  // Validate notes entries
  const MAX_NOTE_CONTENT_BYTES = 50 * 1024 * 1024; // 50 MB

  for (const note of body.notes) {
    if (typeof note.uuid !== 'string' || typeof note.filename !== 'string' || typeof note.content_hash !== 'string' || typeof note.hash_at_last_sync !== 'string') {
      log.warn('invalid sync payload: malformed note entry');
      return c.json({ error: 'Invalid sync payload: each note must have uuid, filename, content_hash, and hash_at_last_sync as strings' }, 422);
    }
    if (!note.uuid || !note.filename || !note.content_hash) {
      log.warn('invalid sync payload: empty string in note entry');
      return c.json({ error: 'Invalid sync payload: note uuid, filename, and content_hash must be non-empty' }, 422);
    }
    if (note.content_hash.length > 128 || note.hash_at_last_sync.length > 128) {
      log.warn(`invalid sync payload: hash field too long (${note.uuid})`);
      return c.json({ error: 'Invalid sync payload: hash fields exceed maximum length' }, 422);
    }
    if (typeof note.modified_at !== 'number' || !Number.isFinite(note.modified_at) || note.modified_at < 0) {
      log.warn(`invalid sync payload: invalid modified_at in note (${note.uuid})`);
      return c.json({ error: 'Invalid sync payload: note modified_at must be a finite non-negative number' }, 400);
    }
    // Validate is_blob field type
    if (note.is_blob !== undefined && typeof note.is_blob !== 'boolean') {
      log.warn(`invalid sync payload: is_blob must be a boolean (${note.uuid})`);
      return c.json({ error: 'Invalid sync payload: is_blob must be a boolean if present' }, 422);
    }
    // Validate content field
    if (note.content !== undefined && typeof note.content !== 'string') {
      log.warn(`invalid sync payload: note content must be a string if present (${note.uuid})`);
      return c.json({ error: 'Invalid sync payload: note content must be a string if present' }, 422);
    }
    if (!note.is_blob) {
      // Non-blob notes must include content when content has changed (not a rename-only).
      // Rename-only = content_hash matches hash_at_last_sync (filename changed but content didn't).
      const isRenameOnly = note.content_hash === note.hash_at_last_sync;
      if (!isRenameOnly && typeof note.content !== 'string') {
        log.warn(`invalid sync payload: non-blob note with changed content must include content (${note.uuid})`);
        return c.json({ error: 'Invalid sync payload: non-blob notes with changed content must include content as a string' }, 422);
      }
    }
    if (typeof note.content === 'string' && Buffer.byteLength(note.content, 'utf8') > MAX_NOTE_CONTENT_BYTES) {
      log.warn(`invalid sync payload: note content too large (${note.uuid})`);
      return c.json({ error: `Invalid sync payload: note content exceeds ${MAX_NOTE_CONTENT_BYTES / 1024 / 1024} MB limit` }, 413);
    }
    // Duplicate UUID detection
    if (noteUuids.has(note.uuid)) {
      log.warn(`invalid sync payload: duplicate UUID in notes (${note.uuid})`);
      return c.json({ error: 'Invalid sync payload: duplicate UUID in notes' }, 422);
    }
    noteUuids.add(note.uuid);
    // Cross-array conflict: same UUID in notes and deleted_uuids
    if (deletedUuidSet.has(note.uuid)) {
      log.warn(`invalid sync payload: UUID in both notes and deleted_uuids (${note.uuid})`);
      return c.json({ error: 'Invalid sync payload: UUID cannot appear in both notes and deleted_uuids' }, 422);
    }
    if (!note.filename.toLowerCase().endsWith('.md')) {
      if (!isImageFilename(note.filename)) {
        log.warn(`invalid sync payload: filename has unsupported extension (${note.filename})`);
        return c.json({ error: 'Invalid sync payload: note filenames must end with .md or be a valid image file' }, 422);
      }
    } else {
      const title = note.filename.slice(0, -3);
      const titleIssues = validateTitle(title);
      if (titleIssues.length > 0) {
        const details = titleIssues.map((issue) => issue.kind).join(', ');
        log.warn(`invalid sync payload: invalid note filename (${note.filename}) [${details}]`);
        return c.json({ error: 'Invalid sync payload: note filenames must map directly to valid note titles' }, 422);
      }
    }
  }

  log.info(`sync request: ${body.notes.length} changed notes, ${body.inventory.length} inventory, ${body.deleted_uuids.length} deletions`);

  const db = getDb();
  const config = loadConfig();
  const versionBefore = getSyncVersion(db);
  const { response: result, version } = processSync(db, config.notesPath, body);
  result.version = version;

  handlePostSync(c, result, body, config);

  // Verify final server state + record
  const versionAfter = getSyncVersion(db);
  if (isRecordingEnabled()) {
    recordSnapshot(body, result, versionBefore, versionAfter);
  }
  const invariants = checkPostSyncInvariants(db, config.notesPath, result, versionBefore, versionAfter);
  if (!invariants.passed) {
    log.error(`Post-sync invariant violations: ${invariants.violations.join('; ')}`);
    if (isRecordingEnabled()) {
      dumpFailingSnapshot(config.databasePath, body, result, invariants);
    }
  }

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
  const changedUuids = result.hash_updates.map((update) => update.uuid);
  applyNoteMutationEffects(getDb(), {
    changedUuids,
    deletedUuids: body.deleted_uuids,
    notifyClients: mutatedServerState,
    excludeClientId: c.req.header('X-Client-Id'),
    incrementVersion: false,
    searchEnabled: config.searchEnabled,
  });

  // Trigger background indexing when sync mutates server state
  if (mutatedServerState && config.searchEnabled) {
    triggerIndexAfterSync();
  }
}

export default sync;
