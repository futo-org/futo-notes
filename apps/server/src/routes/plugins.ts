import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { isTagDefinitionList } from '../plugins/configHelpers.js';
import {
  createOrUpdateLocalPlugin,
  deleteLocalPlugin,
  ensureLocalPluginsLoaded,
  getLocalPluginSource,
} from '../plugins/local.js';
import { getPlugin, getPluginRegistration } from '../plugins/registry.js';
import {
  applyApprovedRunItems,
  approveAllRunItems,
  approveRunItem,
  getPluginRunDetail,
  getPluginsStatus,
  listPluginRuns,
  rejectAllRunItems,
  rejectRunItem,
  setPluginEnabled,
  triggerAllPluginsNow,
  triggerPluginNow,
  updatePluginConfig,
} from '../plugins/scheduler.js';
import { parseJsonBody, errorMessage } from './helpers.js';

const plugins = new Hono();

function isValidScheduleTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
}

function normalizeConfig(
  pluginId: string,
  rawConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const plugin = getPlugin(pluginId);
  if (!plugin) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }

  const next: Record<string, unknown> = {};
  if (!rawConfig) return next;

  const fields = new Map(plugin.configSchema.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(rawConfig)) {
    const field = fields.get(key);
    if (!field) continue;

    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${key} must be a finite number`);
      }
      if (field.min !== undefined && value < field.min) {
        throw new Error(`${key} must be >= ${field.min}`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new Error(`${key} must be <= ${field.max}`);
      }
      next[key] = value;
      continue;
    }

    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`${key} must be a boolean`);
      }
      next[key] = value;
      continue;
    }

    if (field.type === 'tag_list') {
      if (!isTagDefinitionList(value)) {
        throw new Error(`${key} must be an array of { name, description } objects`);
      }
      next[key] = value
        .map((item) => ({
          name: item.name.trim(),
          description: item.description.trim(),
        }))
        .filter((item) => item.name.length > 0);
      continue;
    }

    if (typeof value !== 'string') {
      throw new Error(`${key} must be a string`);
    }
    next[key] = value;
  }

  return next;
}

async function resolvePlugin(pluginId: string) {
  const config = loadConfig();
  await ensureLocalPluginsLoaded(getDb(), config);
  return getPlugin(pluginId);
}

plugins.get('/plugins/status', authMiddleware, async (c) => {
  return c.json(await getPluginsStatus());
});

plugins.get('/plugins/tags', authMiddleware, (c) => {
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT tag FROM note_tags ORDER BY tag').all() as { tag: string }[];
  return c.json({ tags: rows.map((r) => r.tag) });
});

plugins.post('/plugins/:id/enable', authMiddleware, async (c) => {
  const pluginId = c.req.param('id');
  if (!await resolvePlugin(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }
  await setPluginEnabled(pluginId, true);
  return c.json({ enabled: true });
});

plugins.post('/plugins/:id/disable', authMiddleware, async (c) => {
  const pluginId = c.req.param('id');
  if (!await resolvePlugin(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }
  await setPluginEnabled(pluginId, false);
  return c.json({ enabled: false });
});

plugins.post('/plugins/:id/config', authMiddleware, async (c) => {
  const pluginId = c.req.param('id');
  const plugin = await resolvePlugin(pluginId);
  if (!plugin) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }

  const parsed = await parseJsonBody<{
    schedule_kind?: 'manual' | 'daily' | 'weekly';
    schedule_time?: string | null;
    schedule_day?: number | null;
    auto_apply?: boolean;
    config?: Record<string, unknown>;
  }>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  try {
    if (body.schedule_kind && !['manual', 'daily', 'weekly'].includes(body.schedule_kind)) {
      return c.json({ error: 'schedule_kind must be manual, daily, or weekly' }, 400);
    }
    if (body.schedule_time !== undefined && body.schedule_time !== null && !isValidScheduleTime(body.schedule_time)) {
      return c.json({ error: 'schedule_time must be HH:MM' }, 400);
    }
    if (body.schedule_day !== undefined && body.schedule_day !== null && (!Number.isInteger(body.schedule_day) || body.schedule_day < 0 || body.schedule_day > 6)) {
      return c.json({ error: 'schedule_day must be an integer from 0-6' }, 400);
    }
    if (body.auto_apply !== undefined && typeof body.auto_apply !== 'boolean') {
      return c.json({ error: 'auto_apply must be a boolean' }, 400);
    }

    const nextConfig = normalizeConfig(pluginId, body.config);
    await updatePluginConfig(pluginId, {
      scheduleKind: body.schedule_kind,
      scheduleTime: body.schedule_time,
      scheduleDay: body.schedule_day,
      autoApply: body.auto_apply,
      config: nextConfig,
    });
    return c.json({ updated: true });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

plugins.post('/plugins/:id/run', authMiddleware, async (c) => {
  const pluginId = c.req.param('id');
  if (!await resolvePlugin(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }

  try {
    const { runId } = await triggerPluginNow(pluginId);
    return c.json({ started: true, run_id: runId }, 202);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 409);
  }
});

plugins.post('/plugins/run-all', authMiddleware, async (c) => {
  try {
    const { batchId, queuedCount, batch } = await triggerAllPluginsNow();
    return c.json({
      started: true,
      batch_id: batchId,
      queued_count: queuedCount,
      batch,
    }, 202);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 409);
  }
});

plugins.get('/plugins/:id/runs', authMiddleware, async (c) => {
  const pluginId = c.req.param('id');
  await ensureLocalPluginsLoaded(getDb(), loadConfig());
  if (!getPluginRegistration(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }
  const limitRaw = Number(c.req.query('limit') ?? '10');
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;
  return c.json({ runs: listPluginRuns(pluginId, limit) });
});

plugins.get('/plugins/local/:id/source', authMiddleware, async (c) => {
  try {
    const data = await getLocalPluginSource(getDb(), loadConfig(), c.req.param('id'));
    return c.json(data);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 404);
  }
});

plugins.post('/plugins/local', authMiddleware, async (c) => {
  const parsed = await parseJsonBody<{ plugin_id?: string; source?: string }>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  try {
    if (typeof body.plugin_id !== 'string' || body.plugin_id.trim().length === 0) {
      return c.json({ error: 'plugin_id is required' }, 400);
    }
    if (typeof body.source !== 'string' || body.source.trim().length === 0) {
      return c.json({ error: 'source is required' }, 400);
    }

    const registration = await createOrUpdateLocalPlugin(getDb(), loadConfig(), body.plugin_id.trim(), body.source);
    return c.json({
      saved: true,
      plugin: {
        id: registration.plugin.id,
        name: registration.plugin.name,
        description: registration.plugin.description,
        source_kind: registration.sourceKind,
        source_label: registration.sourceLabel,
      },
    }, 201);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

plugins.put('/plugins/local/:id/source', authMiddleware, async (c) => {
  const parsed = await parseJsonBody<{ source?: string }>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  try {
    const pluginId = c.req.param('id');
    if (typeof body.source !== 'string' || body.source.trim().length === 0) {
      return c.json({ error: 'source is required' }, 400);
    }
    const registration = await createOrUpdateLocalPlugin(getDb(), loadConfig(), pluginId, body.source);
    return c.json({
      saved: true,
      plugin: {
        id: registration.plugin.id,
        name: registration.plugin.name,
        description: registration.plugin.description,
        source_kind: registration.sourceKind,
        source_label: registration.sourceLabel,
      },
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

plugins.delete('/plugins/local/:id', authMiddleware, async (c) => {
  try {
    await deleteLocalPlugin(getDb(), loadConfig(), c.req.param('id'));
    return c.json({ deleted: true });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 404);
  }
});

plugins.get('/plugins/runs/:runId', authMiddleware, (c) => {
  try {
    return c.json(getPluginRunDetail(c.req.param('runId')));
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 404);
  }
});

plugins.post('/plugins/runs/:runId/items/:itemId/approve', authMiddleware, (c) => {
  const itemId = Number(c.req.param('itemId'));
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return c.json({ error: 'itemId must be a positive integer' }, 400);
  }
  try {
    approveRunItem(c.req.param('runId'), itemId);
    return c.json({ approved: true });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/items/:itemId/reject', authMiddleware, (c) => {
  const itemId = Number(c.req.param('itemId'));
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return c.json({ error: 'itemId must be a positive integer' }, 400);
  }
  try {
    rejectRunItem(c.req.param('runId'), itemId);
    return c.json({ rejected: true });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/approve-all', authMiddleware, (c) => {
  try {
    approveAllRunItems(c.req.param('runId'));
    return c.json({ approved: true });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/reject-all', authMiddleware, (c) => {
  try {
    rejectAllRunItems(c.req.param('runId'));
    return c.json({ rejected: true });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/apply-approved', authMiddleware, async (c) => {
  try {
    await applyApprovedRunItems(c.req.param('runId'));
    return c.json({ applied: true });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 409);
  }
});

export default plugins;
