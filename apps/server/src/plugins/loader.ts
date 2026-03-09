import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import type { Config } from '../config.js';
import { log } from '../logger.js';
import {
  PLUGIN_EXECUTION_MODES,
  PLUGIN_FREQUENCIES,
  PLUGIN_KINDS,
  PLUGIN_PERMISSIONS,
  type LoadedPlugin,
  type PluginFrequency,
  type PluginInstallRecord,
  type PluginManifest,
  type PluginOrigin,
  type PluginPermission,
} from './types.js';

const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUILTIN_PLUGINS_DIR = path.resolve(process.cwd(), 'builtin-plugins');
const PLUGIN_MANIFEST_FILENAMES = ['plugin.yaml', 'plugin.yml'] as const;
const execFileAsync = promisify(execFile);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`plugin manifest: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function assertOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`plugin manifest: "${field}" must be a non-negative number`);
  }
  return num;
}

function assertOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`plugin manifest: "${field}" must be a boolean`);
  }
  return value;
}

function validatePermissions(value: unknown): PluginPermission[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('plugin manifest: "permissions" must be a non-empty array');
  }

  const allowed = new Set<string>(PLUGIN_PERMISSIONS);
  const permissions = value.map((entry) => {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      throw new Error(`plugin manifest: unsupported permission "${String(entry)}"`);
    }
    return entry as PluginPermission;
  });

  return Array.from(new Set(permissions));
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`plugin manifest: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

export function validatePluginManifest(raw: unknown): PluginManifest {
  if (!isPlainObject(raw)) {
    throw new Error('plugin manifest: expected a YAML object');
  }

  const id = assertString(raw.id, 'id');
  if (!PLUGIN_ID_RE.test(id)) {
    throw new Error('plugin manifest: "id" must use lowercase letters, numbers, and hyphens');
  }

  const kind = assertString(raw.kind, 'kind');
  if (!(PLUGIN_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`plugin manifest: unsupported kind "${kind}"`);
  }

  const frequencyRaw = raw.frequency ?? 'manual';
  if (typeof frequencyRaw !== 'string' || !(PLUGIN_FREQUENCIES as readonly string[]).includes(frequencyRaw)) {
    throw new Error(`plugin manifest: unsupported frequency "${String(frequencyRaw)}"`);
  }

  const selector = raw.selector === undefined ? undefined : raw.selector;
  if (selector !== undefined && !isPlainObject(selector)) {
    throw new Error('plugin manifest: "selector" must be an object');
  }

  const runtime = raw.runtime === undefined ? undefined : raw.runtime;
  if (runtime !== undefined && !isPlainObject(runtime)) {
    throw new Error('plugin manifest: "runtime" must be an object');
  }

  const execution = raw.execution ?? 'full-trust';
  if (typeof execution !== 'string' || !(PLUGIN_EXECUTION_MODES as readonly string[]).includes(execution)) {
    throw new Error(`plugin manifest: unsupported execution mode "${String(execution)}"`);
  }

  const entrypoint = assertOptionalString(raw.entrypoint, 'entrypoint');

  if (entrypoint && (path.isAbsolute(entrypoint) || entrypoint.includes('..'))) {
    throw new Error('plugin manifest: "entrypoint" must be a relative path inside the plugin package');
  }
  if (!entrypoint) {
    throw new Error('plugin manifest: plugins require an entrypoint');
  }

  const explicitPermissions = raw.permissions === undefined ? undefined : validatePermissions(raw.permissions);
  const permissions = execution === 'full-trust'
    ? Array.from(new Set([...(explicitPermissions ?? []), 'full_access']))
    : explicitPermissions;

  if (execution === 'declarative' && !permissions) {
    throw new Error('plugin manifest: declarative plugins must declare permissions');
  }
  if (execution === 'declarative' && permissions.includes('full_access')) {
    throw new Error('plugin manifest: declarative plugins cannot request "full_access"');
  }

  return {
    id,
    name: assertString(raw.name, 'name'),
    version: assertString(raw.version, 'version'),
    publisher: assertString(raw.publisher, 'publisher'),
    description: assertString(raw.description, 'description'),
    kind: kind as PluginManifest['kind'],
    execution,
    entrypoint,
    frequency: frequencyRaw as PluginFrequency,
    enabled_by_default: assertOptionalBoolean(raw.enabled_by_default, 'enabled_by_default'),
    permissions,
    selector: selector ? {
      filename_glob: typeof selector.filename_glob === 'string' ? selector.filename_glob : undefined,
      filename_regex: typeof selector.filename_regex === 'string' ? selector.filename_regex : undefined,
      exclude_filename_glob: typeof selector.exclude_filename_glob === 'string' ? selector.exclude_filename_glob : undefined,
      exclude_filename_regex: typeof selector.exclude_filename_regex === 'string' ? selector.exclude_filename_regex : undefined,
      stale_minutes: assertOptionalNumber(selector.stale_minutes, 'selector.stale_minutes'),
      min_content_chars: assertOptionalNumber(selector.min_content_chars, 'selector.min_content_chars'),
      reprocess_on_content_change: assertOptionalBoolean(selector.reprocess_on_content_change, 'selector.reprocess_on_content_change'),
      max_notes_per_run: assertOptionalNumber(selector.max_notes_per_run, 'selector.max_notes_per_run'),
    } : undefined,
    runtime: runtime ? {
      max_content_chars: assertOptionalNumber(runtime.max_content_chars, 'runtime.max_content_chars'),
      include_recent_titles: assertOptionalNumber(runtime.include_recent_titles, 'runtime.include_recent_titles'),
      few_shot_count: assertOptionalNumber(runtime.few_shot_count, 'runtime.few_shot_count'),
      temperature: assertOptionalNumber(runtime.temperature, 'runtime.temperature'),
      max_tokens: assertOptionalNumber(runtime.max_tokens, 'runtime.max_tokens'),
    } : undefined,
  };
}

export function parsePluginManifest(text: string): PluginManifest {
  const parsed = parseYaml(text);
  return validatePluginManifest(parsed);
}

function readPluginFromDir(dir: string, origin: PluginOrigin, sourceUrl: string | null): LoadedPlugin {
  const manifestPath = path.join(dir, 'plugin.yaml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing plugin.yaml in ${dir}`);
  }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = parsePluginManifest(manifestText);
  let entrypointPath: string | null = null;
  let source: string | null = null;

  if (manifest.entrypoint) {
    entrypointPath = path.resolve(dir, manifest.entrypoint);
    const root = path.resolve(dir);
    if (!entrypointPath.startsWith(root + path.sep) && entrypointPath !== root) {
      throw new Error(`plugin "${manifest.id}" entrypoint resolves outside the package`);
    }
    if (!fs.existsSync(entrypointPath)) {
      throw new Error(`plugin "${manifest.id}" is missing entrypoint ${manifest.entrypoint}`);
    }
    source = fs.readFileSync(entrypointPath, 'utf8');
  }

  return {
    manifest,
    source,
    origin,
    manifestPath,
    entrypointPath,
    sourceUrl,
  };
}

function listPluginDirs(rootDir: string): string[] {
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function getInstalledRoot(config: Config): string {
  return path.resolve(config.pluginsPath);
}

export function ensurePluginDirectories(config: Config): void {
  fs.mkdirSync(getInstalledRoot(config), { recursive: true });
}

function getPluginRow(db: Database.Database, pluginId: string): PluginInstallRecord | null {
  return (db.prepare('SELECT * FROM plugin_installs WHERE plugin_id = ?').get(pluginId) as PluginInstallRecord | undefined) ?? null;
}

function pluginInstallTableExists(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT 1 as found
    FROM sqlite_master
    WHERE type = 'table' AND name = 'plugin_installs'
    LIMIT 1
  `).get() as { found: number } | undefined;
  return row?.found === 1;
}

function upsertPluginInstall(
  db: Database.Database,
  pluginId: string,
  data: {
    origin: PluginOrigin;
    sourceUrl: string | null;
    publisher: string;
    version: string;
    trusted: boolean;
    enabled: boolean;
  },
  preserveEnabled: boolean,
): void {
  const existing = getPluginRow(db, pluginId);
  const now = Date.now();
  const enabled = preserveEnabled && existing ? existing.enabled === 1 : data.enabled;

  db.prepare(`
    INSERT INTO plugin_installs (plugin_id, origin, manifest_url, publisher, version, trusted, enabled, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET
      origin = excluded.origin,
      manifest_url = excluded.manifest_url,
      publisher = excluded.publisher,
      version = excluded.version,
      trusted = excluded.trusted,
      enabled = ${preserveEnabled ? 'plugin_installs.enabled' : 'excluded.enabled'},
      updated_at = excluded.updated_at
  `).run(
    pluginId,
    data.origin,
    data.sourceUrl,
    data.publisher,
    data.version,
    data.trusted ? 1 : 0,
    enabled ? 1 : 0,
    existing?.installed_at ?? now,
    now,
  );
}

function ensurePluginSettings(db: Database.Database): void {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO plugin_settings (key, value, updated_at)
    VALUES ('restricted_mode', '1', ?)
  `).run(now);
}

export function syncBuiltinPlugins(db: Database.Database, config: Config): void {
  ensurePluginDirectories(config);
  if (!pluginInstallTableExists(db)) {
    return;
  }
  ensurePluginSettings(db);

  for (const dir of listPluginDirs(BUILTIN_PLUGINS_DIR)) {
    try {
      const plugin = readPluginFromDir(dir, 'builtin', null);
      upsertPluginInstall(db, plugin.manifest.id, {
        origin: 'builtin',
        sourceUrl: null,
        publisher: plugin.manifest.publisher,
        version: plugin.manifest.version,
        trusted: true,
        enabled: plugin.manifest.enabled_by_default ?? true,
      }, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`plugins: failed to load built-in plugin from ${dir}: ${message}`);
    }
  }
}

export function listPlugins(db: Database.Database, config: Config): LoadedPlugin[] {
  syncBuiltinPlugins(db, config);

  const plugins: LoadedPlugin[] = [];
  const seen = new Set<string>();

  for (const dir of listPluginDirs(BUILTIN_PLUGINS_DIR)) {
    try {
      const plugin = readPluginFromDir(dir, 'builtin', null);
      plugins.push(plugin);
      seen.add(plugin.manifest.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`plugins: failed to load built-in plugin from ${dir}: ${message}`);
    }
  }

  const rows = db.prepare(`
    SELECT * FROM plugin_installs
    WHERE origin = 'installed'
    ORDER BY plugin_id ASC
  `).all() as PluginInstallRecord[];

  for (const row of rows) {
    if (seen.has(row.plugin_id)) {
      log.warn(`plugins: skipping installed plugin "${row.plugin_id}" because a built-in plugin already uses that id`);
      continue;
    }

    try {
      const pluginDir = path.join(getInstalledRoot(config), row.plugin_id);
      const plugin = readPluginFromDir(pluginDir, 'installed', row.manifest_url);
      plugins.push(plugin);
      seen.add(plugin.manifest.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`plugins: failed to load installed plugin "${row.plugin_id}": ${message}`);
    }
  }

  return plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function getPlugin(db: Database.Database, config: Config, pluginId: string): LoadedPlugin | undefined {
  return listPlugins(db, config).find((plugin) => plugin.manifest.id === pluginId);
}

export function getPluginInstallRecord(db: Database.Database, pluginId: string): PluginInstallRecord | null {
  return getPluginRow(db, pluginId);
}

export function setPluginEnabled(db: Database.Database, pluginId: string, enabled: boolean): void {
  const now = Date.now();
  db.prepare(`
    UPDATE plugin_installs
    SET enabled = ?, updated_at = ?
    WHERE plugin_id = ?
  `).run(enabled ? 1 : 0, now, pluginId);
}

export function isRestrictedModeEnabled(db: Database.Database): boolean {
  ensurePluginSettings(db);
  const row = db.prepare(`SELECT value FROM plugin_settings WHERE key = 'restricted_mode'`).get() as { value: string } | undefined;
  return row?.value !== '0';
}

export function setRestrictedMode(db: Database.Database, enabled: boolean): void {
  ensurePluginSettings(db);
  const now = Date.now();
  db.prepare(`
    INSERT INTO plugin_settings (key, value, updated_at)
    VALUES ('restricted_mode', ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(enabled ? '1' : '0', now);
}

interface StagedPluginSource {
  sourceUrl: string;
  manifest: PluginManifest;
  manifestText: string;
  packageDir: string;
  cleanup(): void;
}

function sanitizeSourceUrl(url: string): string {
  const parsed = new URL(url.trim());
  if (!/^(https?|file):$/.test(parsed.protocol)) {
    throw new Error('Plugin source URL must use http, https, or file');
  }
  parsed.hash = '';
  parsed.search = '';
  if (parsed.protocol !== 'file:' && parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed.toString();
}

function isManifestSourceUrl(url: string): boolean {
  const pathname = new URL(url).pathname.toLowerCase();
  return PLUGIN_MANIFEST_FILENAMES.some((filename) => pathname.endsWith(`/${filename}`));
}

function normalizeRepositorySourceUrl(sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol === 'file:') {
    return parsed.toString();
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return parsed.toString();
  }

  let repoSegments = segments;
  const gitlabMarker = segments.indexOf('-');
  if (gitlabMarker >= 0 && ['tree', 'blob', 'raw'].includes(segments[gitlabMarker + 1] ?? '')) {
    repoSegments = segments.slice(0, gitlabMarker);
  } else if ((parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') && segments.length >= 2) {
    repoSegments = segments.slice(0, 2);
  } else if (segments[2] === 'tree' || segments[2] === 'blob') {
    repoSegments = segments.slice(0, 2);
  } else if (segments[2] === 'src' && ['branch', 'tag', 'commit'].includes(segments[3] ?? '')) {
    repoSegments = segments.slice(0, 2);
  }

  parsed.pathname = `/${repoSegments.join('/')}`;
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString();
}

function buildRepositoryCloneCandidates(sourceUrl: string): string[] {
  const normalized = normalizeRepositorySourceUrl(sourceUrl);
  const candidates = new Set<string>([normalized]);
  const parsed = new URL(normalized);
  if (/^https?:$/.test(parsed.protocol) && !parsed.pathname.endsWith('.git')) {
    const withGitSuffix = new URL(normalized);
    withGitSuffix.pathname = `${withGitSuffix.pathname}.git`;
    candidates.add(withGitSuffix.toString());
  }
  return [...candidates];
}

function locateRepoManifestPath(packageDir: string): string | null {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    const manifestPath = path.join(packageDir, filename);
    if (fs.existsSync(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

function validateStagedEntrypoint(packageDir: string, manifest: PluginManifest): void {
  if (!manifest.entrypoint) {
    return;
  }

  const packageRoot = path.resolve(packageDir);
  const entrypointPath = path.resolve(packageDir, manifest.entrypoint);
  if (!entrypointPath.startsWith(packageRoot + path.sep) && entrypointPath !== packageRoot) {
    throw new Error(`plugin "${manifest.id}" entrypoint resolves outside the package`);
  }
  if (!fs.existsSync(entrypointPath)) {
    throw new Error(`plugin "${manifest.id}" is missing entrypoint ${manifest.entrypoint}`);
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  return await res.text();
}

async function stageManifestPluginSource(sourceUrl: string): Promise<StagedPluginSource> {
  const normalizedUrl = sanitizeSourceUrl(sourceUrl);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stonefruit-plugin-'));
  const packageDir = path.join(stagingDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });

  try {
    const manifestText = await fetchText(normalizedUrl);
    const manifest = parsePluginManifest(manifestText);
    fs.writeFileSync(path.join(packageDir, 'plugin.yaml'), manifestText, 'utf8');

    if (manifest.entrypoint) {
      const entrypointText = await fetchText(new URL(manifest.entrypoint, normalizedUrl).toString());
      const entrypointPath = path.join(packageDir, manifest.entrypoint);
      fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
      fs.writeFileSync(entrypointPath, entrypointText, 'utf8');
    }

    validateStagedEntrypoint(packageDir, manifest);
    return {
      sourceUrl: normalizedUrl,
      manifest,
      manifestText,
      packageDir,
      cleanup: () => fs.rmSync(stagingDir, { recursive: true, force: true }),
    };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

async function stageRepositoryPluginSource(sourceUrl: string): Promise<StagedPluginSource> {
  const normalizedUrl = sanitizeSourceUrl(sourceUrl);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stonefruit-plugin-'));
  const packageDir = path.join(stagingDir, 'package');
  const candidates = buildRepositoryCloneCandidates(normalizedUrl);
  const failures: string[] = [];
  let selectedSourceUrl: string | null = null;

  try {
    for (const candidate of candidates) {
      fs.rmSync(packageDir, { recursive: true, force: true });
      try {
        await execFileAsync('git', ['clone', '--depth', '1', candidate, packageDir], {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        selectedSourceUrl = candidate;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${candidate}: ${message}`);
      }
    }

    if (!selectedSourceUrl) {
      throw new Error(`Failed to clone plugin repository from ${normalizedUrl}. ${failures[0] ?? 'No git clone candidates succeeded.'}`);
    }

    fs.rmSync(path.join(packageDir, '.git'), { recursive: true, force: true });
    const manifestPath = locateRepoManifestPath(packageDir);
    if (!manifestPath) {
      throw new Error('Plugin repo must contain plugin.yaml at the repository root');
    }

    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    const manifest = parsePluginManifest(manifestText);
    validateStagedEntrypoint(packageDir, manifest);

    if (path.basename(manifestPath) !== 'plugin.yaml') {
      fs.writeFileSync(path.join(packageDir, 'plugin.yaml'), manifestText, 'utf8');
    }

    return {
      sourceUrl: selectedSourceUrl,
      manifest,
      manifestText,
      packageDir,
      cleanup: () => fs.rmSync(stagingDir, { recursive: true, force: true }),
    };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

async function stagePluginSource(sourceUrl: string): Promise<StagedPluginSource> {
  const normalizedUrl = sanitizeSourceUrl(sourceUrl);
  if (isManifestSourceUrl(normalizedUrl)) {
    return stageManifestPluginSource(normalizedUrl);
  }
  return stageRepositoryPluginSource(normalizedUrl);
}

function writeInstalledPluginFiles(
  config: Config,
  pluginId: string,
  packageDir: string,
  manifestText: string,
): void {
  const pluginDir = path.join(getInstalledRoot(config), pluginId);
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
  fs.cpSync(packageDir, pluginDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });
  fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), manifestText, 'utf8');
}

export async function installPluginFromSource(
  db: Database.Database,
  config: Config,
  sourceUrl: string,
  trust: boolean,
): Promise<LoadedPlugin> {
  if (!trust) {
    throw new Error('Plugin install requires explicit trust confirmation');
  }

  const remote = await stagePluginSource(sourceUrl);
  try {
    if (getPlugin(db, config, remote.manifest.id)) {
      throw new Error(`Plugin "${remote.manifest.id}" is already installed`);
    }

    writeInstalledPluginFiles(config, remote.manifest.id, remote.packageDir, remote.manifestText);
    upsertPluginInstall(db, remote.manifest.id, {
      origin: 'installed',
      sourceUrl: remote.sourceUrl,
      publisher: remote.manifest.publisher,
      version: remote.manifest.version,
      trusted: true,
      enabled: remote.manifest.enabled_by_default ?? false,
    }, false);

    return readPluginFromDir(path.join(getInstalledRoot(config), remote.manifest.id), 'installed', remote.sourceUrl);
  } finally {
    remote.cleanup();
  }
}

export async function updatePluginFromSource(
  db: Database.Database,
  config: Config,
  pluginId: string,
  approvePermissionChanges: boolean,
): Promise<{ plugin: LoadedPlugin; permissionsChanged: boolean }> {
  const record = getPluginInstallRecord(db, pluginId);
  if (!record || record.origin !== 'installed' || !record.manifest_url) {
    throw new Error(`Plugin "${pluginId}" is not updateable`);
  }

  const current = getPlugin(db, config, pluginId);
  if (!current) {
    throw new Error(`Plugin "${pluginId}" is not installed`);
  }

  const remote = await stagePluginSource(record.manifest_url);
  try {
    if (remote.manifest.id !== pluginId) {
      throw new Error(`Plugin source changed id from "${pluginId}" to "${remote.manifest.id}"`);
    }
    if (remote.manifest.publisher !== record.publisher) {
      throw new Error(`Plugin source changed publisher from "${record.publisher}" to "${remote.manifest.publisher}"`);
    }

    const previousPermissions = new Set(current.manifest.permissions);
    const nextPermissions = new Set(remote.manifest.permissions);
    const expanded = [...nextPermissions].some((permission) => !previousPermissions.has(permission));
    if (expanded && !approvePermissionChanges) {
      throw new Error('Plugin update requests additional permissions; approval required');
    }

    writeInstalledPluginFiles(config, remote.manifest.id, remote.packageDir, remote.manifestText);
    upsertPluginInstall(db, remote.manifest.id, {
      origin: 'installed',
      sourceUrl: remote.sourceUrl,
      publisher: remote.manifest.publisher,
      version: remote.manifest.version,
      trusted: record.trusted === 1,
      enabled: record.enabled === 1,
    }, true);

    return {
      plugin: readPluginFromDir(path.join(getInstalledRoot(config), pluginId), 'installed', remote.sourceUrl),
      permissionsChanged: expanded,
    };
  } finally {
    remote.cleanup();
  }
}

export function uninstallPlugin(db: Database.Database, config: Config, pluginId: string): void {
  const record = getPluginInstallRecord(db, pluginId);
  if (!record) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }
  if (record.origin === 'builtin') {
    throw new Error(`Built-in plugin "${pluginId}" cannot be uninstalled`);
  }

  fs.rmSync(path.join(getInstalledRoot(config), pluginId), { recursive: true, force: true });
  db.prepare('DELETE FROM plugin_installs WHERE plugin_id = ?').run(pluginId);
  db.prepare('DELETE FROM transform_state WHERE transform_id = ?').run(pluginId);
  db.prepare('DELETE FROM transform_jobs WHERE transform_id = ?').run(pluginId);
}
