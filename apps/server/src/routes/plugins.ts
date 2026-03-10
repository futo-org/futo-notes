import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { getBuiltinPlugin } from '../plugins/registry.js';
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
  triggerPluginNow,
  updatePluginConfig,
} from '../plugins/scheduler.js';

const plugins = new Hono();

function isValidScheduleTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
}

function normalizeConfig(
  pluginId: string,
  rawConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const plugin = getBuiltinPlugin(pluginId);
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

    if (typeof value !== 'string') {
      throw new Error(`${key} must be a string`);
    }
    next[key] = value;
  }

  return next;
}

plugins.get('/plugins/status', authMiddleware, async (c) => {
  return c.json(await getPluginsStatus());
});

plugins.post('/plugins/:id/enable', authMiddleware, (c) => {
  const pluginId = c.req.param('id');
  if (!getBuiltinPlugin(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }
  setPluginEnabled(pluginId, true);
  return c.json({ enabled: true });
});

plugins.post('/plugins/:id/disable', authMiddleware, (c) => {
  const pluginId = c.req.param('id');
  if (!getBuiltinPlugin(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }
  setPluginEnabled(pluginId, false);
  return c.json({ enabled: false });
});

plugins.post('/plugins/:id/config', authMiddleware, async (c) => {
  const pluginId = c.req.param('id');
  const plugin = getBuiltinPlugin(pluginId);
  if (!plugin) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }

  try {
    const body = await c.req.json<{
      schedule_kind?: 'manual' | 'daily' | 'weekly';
      schedule_time?: string | null;
      schedule_day?: number | null;
      auto_apply?: boolean;
      config?: Record<string, unknown>;
    }>();

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
    updatePluginConfig(pluginId, {
      scheduleKind: body.schedule_kind,
      scheduleTime: body.schedule_time,
      scheduleDay: body.schedule_day,
      autoApply: body.auto_apply,
      config: nextConfig,
    });
    return c.json({ updated: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

plugins.post('/plugins/:id/run', authMiddleware, async (c) => {
  const pluginId = c.req.param('id');
  if (!getBuiltinPlugin(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }

  try {
    const { runId } = await triggerPluginNow(pluginId);
    return c.json({ started: true, run_id: runId }, 202);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

plugins.get('/plugins/:id/runs', authMiddleware, (c) => {
  const pluginId = c.req.param('id');
  if (!getBuiltinPlugin(pluginId)) {
    return c.json({ error: `Unknown plugin: ${pluginId}` }, 404);
  }
  const limitRaw = Number(c.req.query('limit') ?? '10');
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;
  return c.json({ runs: listPluginRuns(pluginId, limit) });
});

plugins.get('/plugins/runs/:runId', authMiddleware, (c) => {
  try {
    return c.json(getPluginRunDetail(c.req.param('runId')));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
  }
});

plugins.post('/plugins/runs/:runId/items/:itemId/approve', authMiddleware, (c) => {
  try {
    approveRunItem(c.req.param('runId'), Number(c.req.param('itemId')));
    return c.json({ approved: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/items/:itemId/reject', authMiddleware, (c) => {
  try {
    rejectRunItem(c.req.param('runId'), Number(c.req.param('itemId')));
    return c.json({ rejected: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/approve-all', authMiddleware, (c) => {
  try {
    approveAllRunItems(c.req.param('runId'));
    return c.json({ approved: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/reject-all', authMiddleware, (c) => {
  try {
    rejectAllRunItems(c.req.param('runId'));
    return c.json({ rejected: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

plugins.post('/plugins/runs/:runId/apply-approved', authMiddleware, async (c) => {
  try {
    await applyApprovedRunItems(c.req.param('runId'));
    return c.json({ applied: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

export default plugins;
