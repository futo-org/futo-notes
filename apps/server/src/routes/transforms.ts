import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { getTransform } from '../transforms/registry.js';
import {
  getTransformsStatus,
  setTransformEnabled,
  setTransformConfigValue,
  triggerTransformNow,
} from '../transforms/scheduler.js';
import { log } from '../logger.js';

const transforms = new Hono();

// GET /transforms/status — all transforms + status + model info
transforms.get('/transforms/status', authMiddleware, (c) => {
  try {
    const status = getTransformsStatus();
    return c.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`transforms: status failed: ${message}`);
    return c.json({ error: message }, 500);
  }
});

// POST /transforms/:id/enable
transforms.post('/transforms/:id/enable', authMiddleware, (c) => {
  const id = c.req.param('id');
  const transform = getTransform(id);
  if (!transform) {
    return c.json({ error: `Unknown transform: ${id}` }, 404);
  }
  setTransformEnabled(id, true);
  return c.json({ enabled: true });
});

// POST /transforms/:id/disable
transforms.post('/transforms/:id/disable', authMiddleware, (c) => {
  const id = c.req.param('id');
  const transform = getTransform(id);
  if (!transform) {
    return c.json({ error: `Unknown transform: ${id}` }, 404);
  }
  setTransformEnabled(id, false);
  return c.json({ enabled: false });
});

// POST /transforms/:id/config — update per-transform settings
transforms.post('/transforms/:id/config', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const transform = getTransform(id);
  if (!transform) {
    return c.json({ error: `Unknown transform: ${id}` }, 404);
  }

  try {
    const body = await c.req.json<Record<string, unknown>>();
    const fieldMap = new Map(transform.configSchema.map((f) => [f.key, f]));
    const errors: string[] = [];

    for (const [key, value] of Object.entries(body)) {
      const field = fieldMap.get(key);
      if (!field) continue;

      if (field.type === 'number') {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          errors.push(`${key}: expected a finite number`);
          continue;
        }
        if (field.min !== undefined && num < field.min) {
          errors.push(`${key}: must be >= ${field.min}`);
          continue;
        }
        if (field.max !== undefined && num > field.max) {
          errors.push(`${key}: must be <= ${field.max}`);
          continue;
        }
        setTransformConfigValue(id, key, String(num));
      } else if (field.type === 'boolean') {
        if (typeof value !== 'boolean' && value !== 'true' && value !== 'false' && value !== 0 && value !== 1) {
          errors.push(`${key}: expected a boolean`);
          continue;
        }
        const bool = value === true || value === 'true' || value === 1;
        setTransformConfigValue(id, key, bool ? '1' : '0');
      } else {
        setTransformConfigValue(id, key, String(value));
      }
    }

    if (errors.length > 0) {
      return c.json({ error: errors.join('; ') }, 400);
    }
    return c.json({ updated: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

// POST /transforms/:id/trigger — run transform now (202 Accepted)
transforms.post('/transforms/:id/trigger', authMiddleware, (c) => {
  const id = c.req.param('id');
  const transform = getTransform(id);
  if (!transform) {
    return c.json({ error: `Unknown transform: ${id}` }, 404);
  }

  try {
    triggerTransformNow(id);
    return c.json({ started: true }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`transforms: trigger failed for "${id}": ${message}`);
    return c.json({ error: message }, 409);
  }
});

// GET /transforms/history — recent actions (last 50)
transforms.get('/transforms/history', authMiddleware, (c) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT transform_id, uuid, action, old_filename, new_filename, executed_at
    FROM transform_history
    ORDER BY executed_at DESC
    LIMIT 50
  `).all();
  return c.json({ history: rows });
});

export default transforms;
