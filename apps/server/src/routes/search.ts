import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { authMiddleware } from '../middleware/auth.js';
import { loadConfig } from '../config.js';
import { triggerIndexNow } from '../search/scheduler.js';
import { getCapabilities, getJobStatus } from '../search/status.js';
import { getDb } from '../db/index.js';
import { log } from '../logger.js';

const search = new Hono();

search.get('/search/capabilities', authMiddleware, (c) => {
  const db = getDb();
  const caps = getCapabilities(db);
  return c.json(caps);
});

search.get('/search/status', authMiddleware, (c) => {
  const db = getDb();
  const status = getJobStatus(db);
  return c.json(status);
});

search.post('/search/reindex', authMiddleware, async (c) => {
  try {
    const jobId = await triggerIndexNow();
    return c.json({ job_id: jobId }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`search: reindex failed: ${message}`);
    return c.json({ error: message }, 409);
  }
});

search.get('/search/index', authMiddleware, (c) => {
  const format = c.req.query('format') || 'sqlite';
  const config = loadConfig();
  const artifactDir = path.join(path.dirname(config.databasePath), 'search-artifacts');

  if (format === 'manifest') {
    const manifestPath = path.join(artifactDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return c.json({ error: 'No search artifact available' }, 404);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return c.json(manifest);
  }

  if (format === 'bin') {
    const binPath = path.join(artifactDir, 'supersearch-v1.bin');
    if (!fs.existsSync(binPath)) {
      return c.json({ error: 'No search artifact available' }, 404);
    }

    const ifNoneMatch = c.req.header('If-None-Match');
    const stat = fs.statSync(binPath);
    const etag = `"${stat.size}-${stat.mtimeMs}"`;
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    c.header('Content-Type', 'application/octet-stream');
    c.header('ETag', etag);
    return stream(c, async (s) => {
      const readable = fs.createReadStream(binPath);
      for await (const chunk of readable) {
        await s.write(chunk as Uint8Array);
      }
    });
  }

  // Default: sqlite
  const dbPath = path.join(artifactDir, 'supersearch-v1.db');
  if (!fs.existsSync(dbPath)) {
    return c.json({ error: 'No search artifact available' }, 404);
  }

  const ifNoneMatch = c.req.header('If-None-Match');
  const stat = fs.statSync(dbPath);
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  c.header('Content-Type', 'application/x-sqlite3');
  c.header('X-Artifact-Version', 'supersearch-v1');
  c.header('ETag', etag);
  return stream(c, async (s) => {
    const readable = fs.createReadStream(dbPath);
    for await (const chunk of readable) {
      await s.write(chunk as Uint8Array);
    }
  });
});

export default search;
