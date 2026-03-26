import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { getNote } from '../db/notes.js';
import { isImageFilename } from '@futo-notes/shared';
import { writeBlobFile, readBlobFile, sanitizeImageFilename } from '../sync/files.js';
import { binaryContentHash } from '../sync/hash.js';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';

const MAX_BLOB_SIZE = 100 * 1024 * 1024; // 100 MB
const PATH_SAFE_RE = /^[a-zA-Z0-9_-]+$/;

const blobSync = new Hono();

blobSync.put('/sync/blob/:uuid', authMiddleware, async (c) => {
  const uuid = c.req.param('uuid');

  if (!PATH_SAFE_RE.test(uuid)) {
    return c.json({ error: 'Invalid UUID format' }, 400);
  }

  const rawFilename = c.req.header('X-Filename');
  const modifiedAtStr = c.req.header('X-Modified-At');

  if (!rawFilename) {
    return c.json({ error: 'X-Filename header is required' }, 400);
  }

  let filename: string;
  try {
    filename = sanitizeImageFilename(rawFilename);
  } catch {
    return c.json({ error: 'Invalid image filename' }, 400);
  }

  if (!isImageFilename(filename)) {
    return c.json({ error: 'Invalid image extension' }, 400);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_BLOB_SIZE) {
    return c.json({ error: `File too large (max ${MAX_BLOB_SIZE / 1024 / 1024} MB)` }, 413);
  }
  if (body.byteLength === 0) {
    return c.json({ error: 'Empty file' }, 400);
  }

  const data = Buffer.from(body);
  const hash = binaryContentHash(data);
  const modifiedAt = modifiedAtStr ? Number(modifiedAtStr) : undefined;
  if (modifiedAt !== undefined && (!Number.isFinite(modifiedAt) || modifiedAt < 0)) {
    return c.json({ error: 'X-Modified-At must be a finite non-negative number' }, 400);
  }
  const config = loadConfig();

  writeBlobFile(config.notesPath, filename, data, modifiedAt);
  log.info(`blob upload: ${filename} (${uuid.slice(0, 8)}) ${data.length} bytes`);

  return c.json({ uuid, content_hash: hash, filename });
});

blobSync.get('/sync/blob/:uuid', authMiddleware, async (c) => {
  const uuid = c.req.param('uuid');

  if (!PATH_SAFE_RE.test(uuid)) {
    return c.json({ error: 'Invalid UUID format' }, 400);
  }

  const db = getDb();
  const note = getNote(db, uuid);

  if (!note) {
    return c.json({ error: 'Not found' }, 404);
  }

  if (!note.is_blob) {
    return c.json({ error: 'Not a blob' }, 400);
  }

  const config = loadConfig();
  const data = readBlobFile(config.notesPath, note.filename);
  if (!data) {
    return c.json({ error: 'File not found on disk' }, 404);
  }

  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${note.filename}"`,
      'Content-Length': String(data.length),
    },
  });
});

export default blobSync;
