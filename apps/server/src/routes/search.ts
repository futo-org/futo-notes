import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { authMiddleware } from '../middleware/auth.js';
import { loadConfig } from '../config.js';
import { triggerIndexNow, getSchedulerState } from '../search/scheduler.js';
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
  const scheduler = getSchedulerState();
  return c.json({ ...status, scheduler });
});

search.post('/search/reindex', authMiddleware, (c) => {
  try {
    triggerIndexNow();
    return c.json({ started: true }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`search: reindex failed: ${message}`);
    return c.json({ error: message }, 409);
  }
});

search.post('/search/set-enhanced-search', authMiddleware, async (c) => {
  try {
    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'Missing or invalid enabled flag' }, 400);
    }

    const { setEnhancedSearchEnabled } = await import('../search/scheduler.js');
    await setEnhancedSearchEnabled(body.enabled);

    return c.json({ enabled: body.enabled }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`search: set-enhanced-search failed: ${message}`);
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

search.post('/search/embed-query', authMiddleware, async (c) => {
  try {
    const body = await c.req.json<{ query: string }>();
    if (!body.query || typeof body.query !== 'string') {
      return c.json({ error: 'Missing or invalid query' }, 400);
    }

    const [{ holder }, { isBuiltinLlmLoaded }] = await Promise.all([
      import('../schedulerLock.js'),
      import('../plugins/llm.js'),
    ]);
    if (holder() === 'plugins' || isBuiltinLlmLoaded()) {
      return c.json({ error: 'Embedding model temporarily unavailable while plugins are running' }, 503);
    }

    const { getActiveModel } = await import('../search/modelManager.js');
    let model = getActiveModel();
    if (!model) {
      // Model not loaded yet — try to load it on-demand
      const { ensureModelLoaded } = await import('../search/scheduler.js');
      try {
        const loaded = await ensureModelLoaded();
        if (!loaded) {
          return c.json({ error: 'Embedding model not available' }, 503);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`search: ensureModelLoaded failed: ${message}`);
        return c.json({ error: 'Embedding model not available' }, 503);
      }
      model = getActiveModel();
      if (!model) {
        return c.json({ error: 'Embedding model not available' }, 503);
      }
    }

    const vector = await model.embedQuery(body.query);
    return c.json({ vector, dims: model.dims, model: 'active' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`search: embed-query failed: ${message}`);
    return c.json({ error: message }, 500);
  }
});

export default search;
