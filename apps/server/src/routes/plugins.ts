import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { loadConfig } from '../config.js';
import { getDb } from '../db/index.js';
import {
  getPlugin,
  installPluginFromSource,
  isRestrictedModeEnabled,
  listPlugins,
  setRestrictedMode,
  setPluginEnabled,
  uninstallPlugin,
  updatePluginFromSource,
} from '../plugins/loader.js';
import { getPluginsStatus, triggerPluginNow } from '../plugins/scheduler.js';
import { log } from '../logger.js';

const plugins = new Hono();

plugins.get('/plugins/status', authMiddleware, async (c) => {
  try {
    return c.json(await getPluginsStatus());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`plugins: status failed: ${message}`);
    return c.json({ error: message }, 500);
  }
});

plugins.get('/plugins', authMiddleware, (c) => {
  const db = getDb();
  const config = loadConfig();
  const items = listPlugins(db, config).map((plugin) => ({
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    publisher: plugin.manifest.publisher,
    description: plugin.manifest.description,
    origin: plugin.origin,
    permissions: plugin.manifest.permissions,
    frequency: plugin.manifest.frequency ?? 'manual',
    kind: plugin.manifest.kind,
  }));
  return c.json({ plugins: items });
});

plugins.get('/plugins/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const config = loadConfig();
  const plugin = getPlugin(db, config, id);
  if (!plugin) {
    return c.json({ error: `Unknown plugin: ${id}` }, 404);
  }
  return c.json({
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    publisher: plugin.manifest.publisher,
    description: plugin.manifest.description,
    origin: plugin.origin,
    permissions: plugin.manifest.permissions,
    frequency: plugin.manifest.frequency ?? 'manual',
    kind: plugin.manifest.kind,
    execution: plugin.manifest.execution ?? 'full-trust',
    manifest_path: plugin.manifestPath,
    entrypoint_path: plugin.entrypointPath,
    source_url: plugin.sourceUrl,
    manifest_url: plugin.sourceUrl,
    source: plugin.source,
  });
});

plugins.post('/plugins/install', authMiddleware, async (c) => {
  try {
    const body = await c.req.json<{ source_url?: string; manifest_url?: string; trust?: boolean }>();
    const sourceUrl = body.source_url ?? body.manifest_url;
    if (!sourceUrl) {
      return c.json({ error: 'source_url is required' }, 400);
    }

    const plugin = await installPluginFromSource(getDb(), loadConfig(), sourceUrl, body.trust === true);
    return c.json({
      installed: true,
      plugin: {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        publisher: plugin.manifest.publisher,
      },
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

plugins.post('/plugins/:id/enable', authMiddleware, (c) => {
  const id = c.req.param('id');
  const plugin = getPlugin(getDb(), loadConfig(), id);
  if (!plugin) {
    return c.json({ error: `Unknown plugin: ${id}` }, 404);
  }
  setPluginEnabled(getDb(), id, true);
  return c.json({ enabled: true });
});

plugins.post('/plugins/:id/disable', authMiddleware, (c) => {
  const id = c.req.param('id');
  const plugin = getPlugin(getDb(), loadConfig(), id);
  if (!plugin) {
    return c.json({ error: `Unknown plugin: ${id}` }, 404);
  }
  setPluginEnabled(getDb(), id, false);
  return c.json({ enabled: false });
});

plugins.post('/plugins/:id/run', authMiddleware, (c) => {
  const id = c.req.param('id');
  const plugin = getPlugin(getDb(), loadConfig(), id);
  if (!plugin) {
    return c.json({ error: `Unknown plugin: ${id}` }, 404);
  }

  try {
    triggerPluginNow(id);
    return c.json({ started: true }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`plugins: manual run failed for "${id}": ${message}`);
    return c.json({ error: message }, 409);
  }
});

plugins.post('/plugins/:id/update', authMiddleware, async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json<{ approve_permission_changes?: boolean }>().catch(() => ({}));
    const result = await updatePluginFromSource(getDb(), loadConfig(), id, body.approve_permission_changes === true);
    return c.json({
      updated: true,
      permissions_changed: result.permissionsChanged,
      plugin: {
        id: result.plugin.manifest.id,
        name: result.plugin.manifest.name,
        version: result.plugin.manifest.version,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /approval required/i.test(message) ? 409 : 400;
    return c.json({ error: message }, status);
  }
});

plugins.delete('/plugins/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  try {
    uninstallPlugin(getDb(), loadConfig(), id);
    return c.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

plugins.post('/plugins/restricted-mode', authMiddleware, async (c) => {
  try {
    const body = await c.req.json<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    setRestrictedMode(getDb(), body.enabled);
    return c.json({ restricted_mode: isRestrictedModeEnabled(getDb()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

plugins.get('/plugins/history', authMiddleware, (c) => {
  const rows = getDb().prepare(`
    SELECT transform_id as plugin_id, uuid, action, old_filename, new_filename, executed_at
    FROM transform_history
    ORDER BY executed_at DESC
    LIMIT 50
  `).all();
  return c.json({ history: rows });
});

export default plugins;
