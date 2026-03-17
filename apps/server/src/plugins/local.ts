import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { BuiltinPlugin, PluginConfigField, PluginInstallRow, PluginRegistration } from './types.js';
import { isTagDefinitionList } from './configHelpers.js';
import {
  listBuiltinPlugins,
  resetLocalPluginRegistrations,
  removeLocalPluginRegistration,
  upsertLocalPluginRegistration,
} from './registry.js';

const SOURCE_FILENAME = 'source.ts';
const COMPILED_FILENAME = 'index.mjs';
const ACTIVE_LOAD_STATUSES = new Set(['ready', 'error']);
const ACTIVE_SCHEDULE_KINDS = new Set(['manual', 'daily', 'weekly']);

let loadedPluginsPath: string | null = null;
let pendingLoad: Promise<void> | null = null;

function assertPluginId(pluginId: string): void {
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(pluginId)) {
    throw new Error('plugin_id must contain only lowercase letters, numbers, hyphens, or underscores');
  }
}

function placeholderPlugin(pluginId: string, message: string): BuiltinPlugin {
  return {
    id: pluginId,
    name: pluginId,
    description: message,
    defaultEnabled: false,
    defaultSchedule: { kind: 'manual', time: null, day: null },
    defaultAutoApply: true,
    configSchema: [],
    async run() {
      throw new Error(message);
    },
  };
}

function toRegistration(install: PluginInstallRow, plugin: BuiltinPlugin, loadError: string | null): PluginRegistration {
  return {
    plugin,
    sourceKind: 'local',
    sourceLabel: 'Local',
    sourcePath: install.source_path,
    compiledPath: install.compiled_path,
    loadStatus: install.load_status,
    loadError,
    canEdit: true,
    canDelete: true,
    updatedAt: install.updated_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeConfigSchema(pluginId: string, value: unknown): PluginConfigField[] {
  if (!Array.isArray(value)) {
    throw new Error(`Local plugin "${pluginId}" must export configSchema as an array`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}] must be an object`);
    }

    const key = item.key;
    const label = item.label;
    const type = item.type;
    const defaultValue = item.default;
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}].key must be a non-empty string`);
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}].label must be a non-empty string`);
    }
    if (type !== 'boolean' && type !== 'number' && type !== 'string' && type !== 'tag_list') {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}].type must be boolean, number, string, or tag_list`);
    }
    if (type === 'boolean' && typeof defaultValue !== 'boolean') {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}].default must be a boolean`);
    }
    if (type === 'number' && (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue))) {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}].default must be a finite number`);
    }
    if (type === 'string' && typeof defaultValue !== 'string') {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}].default must be a string`);
    }
    if (type === 'tag_list' && !isTagDefinitionList(defaultValue)) {
      throw new Error(`Local plugin "${pluginId}" configSchema[${index}].default must be an array of { name, description } objects`);
    }

    return {
      key,
      label,
      type,
      default: defaultValue,
      description: typeof item.description === 'string' ? item.description : undefined,
      min: typeof item.min === 'number' ? item.min : undefined,
      max: typeof item.max === 'number' ? item.max : undefined,
    };
  });
}

function validatePluginObject(candidate: unknown, expectedPluginId: string): BuiltinPlugin {
  if (!isRecord(candidate)) {
    throw new Error('Plugin module must export an object as default or named "plugin"');
  }

  const {
    id,
    name,
    description,
    defaultEnabled,
    defaultSchedule,
    defaultAutoApply,
    configSchema,
    run,
  } = candidate;

  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Plugin export must include a non-empty string id');
  }
  if (id !== expectedPluginId) {
    throw new Error(`Plugin export id "${id}" does not match requested plugin_id "${expectedPluginId}"`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Local plugin "${id}" must include a non-empty string name`);
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`Local plugin "${id}" must include a non-empty string description`);
  }
  if (typeof defaultEnabled !== 'boolean') {
    throw new Error(`Local plugin "${id}" must include boolean defaultEnabled`);
  }
  if (!isRecord(defaultSchedule) || typeof defaultSchedule.kind !== 'string' || !ACTIVE_SCHEDULE_KINDS.has(defaultSchedule.kind)) {
    throw new Error(`Local plugin "${id}" must include defaultSchedule.kind of manual, daily, or weekly`);
  }
  if (typeof defaultAutoApply !== 'boolean') {
    throw new Error(`Local plugin "${id}" must include boolean defaultAutoApply`);
  }
  if (typeof run !== 'function') {
    throw new Error(`Local plugin "${id}" must export an async run(context) function`);
  }

  return {
    id,
    name,
    description,
    defaultEnabled,
    defaultSchedule: {
      kind: defaultSchedule.kind as BuiltinPlugin['defaultSchedule']['kind'],
      time: typeof defaultSchedule.time === 'string' ? defaultSchedule.time : null,
      day: typeof defaultSchedule.day === 'number' ? defaultSchedule.day : null,
    },
    defaultAutoApply,
    configSchema: normalizeConfigSchema(id, configSchema ?? []),
    run: run as BuiltinPlugin['run'],
  };
}

async function loadPluginFromCompiled(compiledPath: string, pluginId: string): Promise<BuiltinPlugin> {
  const href = `${pathToFileURL(compiledPath).href}?v=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = await import(href);
  const candidate = mod.default ?? mod.plugin;
  return validatePluginObject(candidate, pluginId);
}

function ensureBuiltinPluginIdAvailable(pluginId: string): void {
  if (listBuiltinPlugins().some((plugin) => plugin.id === pluginId)) {
    throw new Error(`Plugin id "${pluginId}" is reserved by a built-in automation`);
  }
}

async function compileSource(sourcePath: string, compiledPath: string): Promise<void> {
  await esbuild.build({
    entryPoints: [sourcePath],
    outfile: compiledPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    sourcemap: false,
    logLevel: 'silent',
    packages: 'external',
  });
}

function getInstallRow(db: Database.Database, pluginId: string): PluginInstallRow | undefined {
  return db.prepare(`
    SELECT plugin_id, source_kind, source_path, compiled_path, load_status, load_error, created_at, updated_at, deleted_at
    FROM plugin_installs
    WHERE plugin_id = ?
  `).get(pluginId) as PluginInstallRow | undefined;
}

function listActiveInstalls(db: Database.Database): PluginInstallRow[] {
  return db.prepare(`
    SELECT plugin_id, source_kind, source_path, compiled_path, load_status, load_error, created_at, updated_at, deleted_at
    FROM plugin_installs
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC, plugin_id ASC
  `).all() as PluginInstallRow[];
}

async function ensurePluginsPath(rootPath: string): Promise<void> {
  await fs.mkdir(rootPath, { recursive: true });
}

async function writeInstallRow(
  db: Database.Database,
  pluginId: string,
  sourcePath: string,
  compiledPath: string,
  loadStatus: 'ready' | 'error',
  loadError: string | null,
): Promise<PluginInstallRow> {
  const now = Date.now();
  db.prepare(`
    INSERT INTO plugin_installs (
      plugin_id, source_kind, source_path, compiled_path, load_status, load_error, created_at, updated_at, deleted_at
    ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(plugin_id) DO UPDATE SET
      source_kind = 'local',
      source_path = excluded.source_path,
      compiled_path = excluded.compiled_path,
      load_status = excluded.load_status,
      load_error = excluded.load_error,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `).run(pluginId, sourcePath, compiledPath, loadStatus, loadError, now, now);

  const row = getInstallRow(db, pluginId);
  if (!row) {
    throw new Error(`Failed to persist local plugin install for "${pluginId}"`);
  }
  return row;
}

function markDeleted(db: Database.Database, pluginId: string): void {
  db.prepare(`
    UPDATE plugin_installs
    SET deleted_at = ?, updated_at = ?, load_error = NULL
    WHERE plugin_id = ? AND deleted_at IS NULL
  `).run(Date.now(), Date.now(), pluginId);
}

async function stageLocalPlugin(rootPath: string, pluginId: string, source: string): Promise<{
  stageDir: string;
  sourcePath: string;
  compiledPath: string;
  plugin: BuiltinPlugin;
}> {
  const stageDir = await fs.mkdtemp(path.join(rootPath, `${pluginId}-staging-`));
  const sourcePath = path.join(stageDir, SOURCE_FILENAME);
  const compiledPath = path.join(stageDir, COMPILED_FILENAME);

  await fs.writeFile(sourcePath, source, 'utf8');
  await compileSource(sourcePath, compiledPath);
  const plugin = await loadPluginFromCompiled(compiledPath, pluginId);
  return { stageDir, sourcePath, compiledPath, plugin };
}

async function replacePluginDirectory(rootPath: string, pluginId: string, stageDir: string): Promise<{
  finalDir: string;
  sourcePath: string;
  compiledPath: string;
}> {
  const finalDir = path.join(rootPath, pluginId);
  const backupDir = path.join(rootPath, `${pluginId}-backup-${crypto.randomUUID()}`);
  const hadExisting = await fs.stat(finalDir).then(() => true).catch(() => false);

  if (hadExisting) {
    await fs.rename(finalDir, backupDir);
  }

  try {
    await fs.rename(stageDir, finalDir);
    if (hadExisting) {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (hadExisting) {
      await fs.rename(backupDir, finalDir).catch(() => {});
    }
    throw err;
  }

  return {
    finalDir,
    sourcePath: path.join(finalDir, SOURCE_FILENAME),
    compiledPath: path.join(finalDir, COMPILED_FILENAME),
  };
}

async function recordInstallLoadError(db: Database.Database, install: PluginInstallRow, loadError: string): Promise<void> {
  const row = await writeInstallRow(db, install.plugin_id, install.source_path, install.compiled_path, 'error', loadError);
  upsertLocalPluginRegistration(
    toRegistration(row, placeholderPlugin(install.plugin_id, 'Local plugin failed to load'), loadError),
  );
}

export async function ensureLocalPluginsLoaded(db: Database.Database, config: Config): Promise<void> {
  const rootPath = path.resolve(config.pluginsPath);
  if (loadedPluginsPath === rootPath && !pendingLoad) {
    return;
  }
  if (pendingLoad) {
    return pendingLoad;
  }

  pendingLoad = (async () => {
    await ensurePluginsPath(rootPath);
    resetLocalPluginRegistrations();
    loadedPluginsPath = rootPath;

    const installs = listActiveInstalls(db);
    for (const install of installs) {
      try {
        const plugin = await loadPluginFromCompiled(install.compiled_path, install.plugin_id);
        const row = await writeInstallRow(db, install.plugin_id, install.source_path, install.compiled_path, 'ready', null);
        upsertLocalPluginRegistration(toRegistration(row, plugin, null));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordInstallLoadError(db, install, message);
      }
    }
  })().finally(() => {
    pendingLoad = null;
  });

  return pendingLoad;
}

export async function createOrUpdateLocalPlugin(
  db: Database.Database,
  config: Config,
  pluginId: string,
  source: string,
): Promise<PluginRegistration> {
  assertPluginId(pluginId);
  ensureBuiltinPluginIdAvailable(pluginId);

  const rootPath = path.resolve(config.pluginsPath);
  await ensurePluginsPath(rootPath);

  const staged = await stageLocalPlugin(rootPath, pluginId, source);
  let finalPaths: { finalDir: string; sourcePath: string; compiledPath: string } | null = null;

  try {
    finalPaths = await replacePluginDirectory(rootPath, pluginId, staged.stageDir);
    const plugin = await loadPluginFromCompiled(finalPaths.compiledPath, pluginId);
    const install = await writeInstallRow(db, pluginId, finalPaths.sourcePath, finalPaths.compiledPath, 'ready', null);
    const registration = toRegistration(install, plugin, null);
    upsertLocalPluginRegistration(registration);
    loadedPluginsPath = rootPath;
    return registration;
  } catch (err) {
    await fs.rm(staged.stageDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function getLocalPluginSource(
  db: Database.Database,
  config: Config,
  pluginId: string,
): Promise<{ pluginId: string; source: string; updatedAt: number | null; loadError: string | null }> {
  await ensureLocalPluginsLoaded(db, config);
  const row = getInstallRow(db, pluginId);
  if (!row || row.deleted_at !== null) {
    throw new Error(`Unknown local plugin: ${pluginId}`);
  }

  const source = await fs.readFile(row.source_path, 'utf8');
  return {
    pluginId,
    source,
    updatedAt: row.updated_at,
    loadError: row.load_error,
  };
}

export async function deleteLocalPlugin(db: Database.Database, config: Config, pluginId: string): Promise<void> {
  await ensureLocalPluginsLoaded(db, config);
  const row = getInstallRow(db, pluginId);
  if (!row || row.deleted_at !== null) {
    throw new Error(`Unknown local plugin: ${pluginId}`);
  }

  markDeleted(db, pluginId);
  removeLocalPluginRegistration(pluginId);
  await fs.rm(path.join(path.resolve(config.pluginsPath), pluginId), { recursive: true, force: true });
}

export function isKnownLocalPlugin(db: Database.Database, pluginId: string): boolean {
  const row = getInstallRow(db, pluginId);
  return Boolean(row && row.deleted_at === null && ACTIVE_LOAD_STATUSES.has(row.load_status));
}
