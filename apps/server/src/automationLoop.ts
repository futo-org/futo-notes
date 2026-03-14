import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SyncResponse } from '@futo-notes/shared';
import { createApp } from './app.js';
import { closeDb, initDb } from './db/index.js';
import { createPluginTables } from './db/pluginSchema.js';
import { createSearchTables } from './db/searchSchema.js';
import { resetLocalPluginRegistrations } from './plugins/registry.js';
import { contentHash } from './sync/hash.js';
import { listNoteFiles, readNoteFile } from './sync/files.js';

const DEFAULT_PASSWORD = 'automation-loop-password';

export interface AutomationLoopOptions {
  sourcePath?: string;
  outputRoot?: string;
  modelsPath?: string;
  plugins?: string[];
}

export interface AutomationLoopPluginResult {
  pluginId: string;
  pluginName: string;
  status: string;
  errorMessage: string | null;
  runId: string | null;
  detailPath: string | null;
}

export interface AutomationLoopResult {
  sourcePath: string;
  runDir: string;
  workingVaultPath: string;
  diffPath: string;
  summaryPath: string;
  reportPath: string;
  pluginResults: AutomationLoopPluginResult[];
  changedFiles: string[];
}

type AuthHeaders = Record<string, string>;

interface PluginStatusResponse {
  plugins: Array<{
    id: string;
    name: string;
    source_kind: string;
    enabled: boolean;
    auto_apply: boolean;
    config: Record<string, unknown>;
  }>;
  run_all_batch: {
    batch_id: string;
    status: string;
    items: Array<{
      plugin_id: string;
      plugin_name: string;
      status: string;
      run_id: string | null;
      error_message: string | null;
    }>;
  } | null;
}

interface PluginRunDetailResponse {
  run: {
    plugin_id: string;
    status: string;
    error_message: string | null;
  };
  items: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
}

function repoRootPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..');
}

function expandHome(value: string): string {
  if (!value.startsWith('~/')) return value;
  return path.join(os.homedir(), value.slice(2));
}

function isoTimestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'vault';
}

function defaultOutputRoot(): string {
  return path.join(repoRootPath(), '.tmp', 'automation-loop');
}

function defaultModelsPath(): string {
  return process.env.MODELS_PATH || path.join(repoRootPath(), 'data', 'models');
}

function buildSyncPayload(notesDir: string): {
  notes: Array<{
    uuid: string;
    filename: string;
    modified_at: number;
    content_hash: string;
    hash_at_last_sync: string;
    content: string;
  }>;
  inventory: Array<{
    uuid: string;
    filename: string;
    modified_at: number;
    content_hash: string;
  }>;
  deleted_uuids: string[];
  manifest: Array<{ uuid: string; filename: string }>;
} {
  const filenames = listNoteFiles(notesDir).sort((a, b) => a.localeCompare(b));
  const notes = filenames.map((filename) => {
    const fullPath = path.join(notesDir, filename);
    const stat = fs.statSync(fullPath);
    const content = readNoteFile(notesDir, filename) ?? '';
    const uuid = crypto.randomUUID();
    const hash = contentHash(content);
    return {
      uuid,
      filename,
      modified_at: stat.mtimeMs,
      content_hash: hash,
      hash_at_last_sync: '',
      content,
    };
  });

  return {
    notes,
    inventory: notes.map((note) => ({
      uuid: note.uuid,
      filename: note.filename,
      modified_at: note.modified_at,
      content_hash: note.content_hash,
    })),
    deleted_uuids: [],
    manifest: notes.map((note) => ({ uuid: note.uuid, filename: note.filename })),
  };
}

function listChangedFiles(sourcePath: string, workingVaultPath: string): string[] {
  const sourceFiles = new Set(fs.readdirSync(sourcePath).filter((entry) => entry.endsWith('.md')));
  const workingFiles = new Set(fs.readdirSync(workingVaultPath).filter((entry) => entry.endsWith('.md')));
  const allFiles = Array.from(new Set([...sourceFiles, ...workingFiles])).sort((a, b) => a.localeCompare(b));

  const changed: string[] = [];
  for (const filename of allFiles) {
    const sourceExists = sourceFiles.has(filename);
    const workingExists = workingFiles.has(filename);
    if (!sourceExists) {
      changed.push(`A ${filename}`);
      continue;
    }
    if (!workingExists) {
      changed.push(`D ${filename}`);
      continue;
    }
    const before = fs.readFileSync(path.join(sourcePath, filename), 'utf8');
    const after = fs.readFileSync(path.join(workingVaultPath, filename), 'utf8');
    if (before !== after) {
      changed.push(`M ${filename}`);
    }
  }
  return changed;
}

function writeDiff(sourcePath: string, workingVaultPath: string, diffPath: string): void {
  const git = spawnSync(
    'git',
    ['diff', '--no-index', '--no-ext-diff', '--', sourcePath, workingVaultPath],
    { encoding: 'utf8' },
  );

  if (!git.error && (git.status === 0 || git.status === 1)) {
    fs.writeFileSync(diffPath, git.stdout, 'utf8');
    return;
  }

  const diff = spawnSync(
    'diff',
    ['-ru', '--', sourcePath, workingVaultPath],
    { encoding: 'utf8' },
  );

  if (!diff.error && (diff.status === 0 || diff.status === 1)) {
    fs.writeFileSync(diffPath, diff.stdout, 'utf8');
    return;
  }

  const message = git.error
    ? `git diff failed: ${git.error.message}`
    : diff.error
      ? `diff failed: ${diff.error.message}`
      : `git diff exited ${git.status}; diff exited ${diff.status}`;
  fs.writeFileSync(diffPath, `${message}\n`, 'utf8');
}

function writeSummary(
  summaryPath: string,
  result: Pick<AutomationLoopResult, 'sourcePath' | 'workingVaultPath' | 'diffPath' | 'changedFiles' | 'pluginResults'>,
): void {
  const lines = [
    `Source vault: ${result.sourcePath}`,
    `Working vault: ${result.workingVaultPath}`,
    `Diff: ${result.diffPath}`,
    '',
    'Plugin results:',
    ...result.pluginResults.map((plugin) => (
      `${plugin.status.toUpperCase()} ${plugin.pluginId}${plugin.errorMessage ? ` - ${plugin.errorMessage}` : ''}`
    )),
    '',
    'Changed files:',
    ...(result.changedFiles.length > 0 ? result.changedFiles : ['(none)']),
    '',
  ];
  fs.writeFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

async function requestJson<T>(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; data: T }> {
  const init: RequestInit = {
    method,
    headers: { ...(headers ?? {}) },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await app.request(url, init);
  const data = await response.json() as T;
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data
      ? String((data as Record<string, unknown>).error)
      : `${method} ${url} failed with ${response.status}`;
    throw new Error(message);
  }

  return { status: response.status, data };
}

async function setupAuth(app: ReturnType<typeof createApp>): Promise<AuthHeaders> {
  await requestJson(app, 'POST', '/setup', { password: DEFAULT_PASSWORD });
  const login = await requestJson<{ token: string }>(app, 'POST', '/login', { password: DEFAULT_PASSWORD });
  return { Authorization: `Bearer ${login.data.token}` };
}

async function bootstrapVault(app: ReturnType<typeof createApp>, headers: AuthHeaders, workingVaultPath: string): Promise<SyncResponse> {
  const payload = buildSyncPayload(workingVaultPath);
  const sync = await requestJson<SyncResponse>(app, 'POST', '/sync', {
    notes: payload.notes,
    inventory: payload.inventory,
    deleted_uuids: payload.deleted_uuids,
  }, headers);
  return sync.data;
}

async function configurePlugins(
  app: ReturnType<typeof createApp>,
  headers: AuthHeaders,
  requestedPlugins: string[] | undefined,
): Promise<Array<{ id: string; name: string }>> {
  const status = await requestJson<PluginStatusResponse>(app, 'GET', '/plugins/status', undefined, headers);
  const builtins = status.data.plugins
    .filter((plugin) => plugin.source_kind === 'builtin')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const selected = requestedPlugins && requestedPlugins.length > 0
    ? builtins.filter((plugin) => requestedPlugins.includes(plugin.id))
    : builtins;

  if (requestedPlugins && requestedPlugins.length > 0) {
    const found = new Set(selected.map((plugin) => plugin.id));
    const missing = requestedPlugins.filter((pluginId) => !found.has(pluginId));
    if (missing.length > 0) {
      throw new Error(`Unknown built-in plugin ids: ${missing.join(', ')}`);
    }
  }

  if (selected.length === 0) {
    throw new Error('No built-in plugins selected for automation loop');
  }

  const selectedIds = new Set(selected.map((plugin) => plugin.id));
  for (const plugin of builtins) {
    if (!selectedIds.has(plugin.id)) {
      await requestJson(app, 'POST', `/plugins/${plugin.id}/disable`, undefined, headers);
    }
  }

  for (const plugin of selected) {
    await requestJson(app, 'POST', `/plugins/${plugin.id}/config`, {
      schedule_kind: 'manual',
      auto_apply: true,
      config: plugin.config,
    }, headers);
    await requestJson(app, 'POST', `/plugins/${plugin.id}/enable`, undefined, headers);
  }

  return selected.map((plugin) => ({ id: plugin.id, name: plugin.name }));
}

async function waitForBatchCompletion(
  app: ReturnType<typeof createApp>,
  headers: AuthHeaders,
  batchId: string,
): Promise<NonNullable<PluginStatusResponse['run_all_batch']>> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const status = await requestJson<PluginStatusResponse>(app, 'GET', '/plugins/status', undefined, headers);
    const batch = status.data.run_all_batch;
    if (batch && batch.batch_id === batchId && batch.status === 'completed') {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for automation batch ${batchId}`);
}

function withEnvironment<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  return run().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

export async function runAutomationLoop(options: AutomationLoopOptions = {}): Promise<AutomationLoopResult> {
  const sourcePath = path.resolve(expandHome(options.sourcePath ?? '~/Documents/demo-vault-backup'));
  const outputRoot = path.resolve(expandHome(options.outputRoot ?? defaultOutputRoot()));
  const modelsPath = path.resolve(expandHome(options.modelsPath ?? defaultModelsPath()));

  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`Source vault does not exist or is not a directory: ${sourcePath}`);
  }

  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(modelsPath, { recursive: true });

  const runDir = path.join(outputRoot, `${isoTimestampForPath()}-${slugifySegment(path.basename(sourcePath))}`);
  const workingVaultPath = path.join(runDir, 'vault');
  const pluginsPath = path.join(runDir, 'plugins');
  const dbPath = path.join(runDir, 'server.db');
  const runsPath = path.join(runDir, 'runs');
  const diffPath = path.join(runDir, 'diff.patch');
  const summaryPath = path.join(runDir, 'summary.txt');
  const reportPath = path.join(runDir, 'report.json');

  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(sourcePath, workingVaultPath, { recursive: true });
  fs.mkdirSync(pluginsPath, { recursive: true });
  fs.mkdirSync(runsPath, { recursive: true });

  const envVars = {
    DATABASE_PATH: dbPath,
    NOTES_PATH: workingVaultPath,
    PLUGINS_PATH: pluginsPath,
    MODELS_PATH: modelsPath,
    SEARCH_ENABLED: 'false',
    PLUGINS_ENABLED: 'true',
    NODE_ENV: 'test',
  };

  try {
    return await withEnvironment(envVars, async () => {
      closeDb();
      resetLocalPluginRegistrations();

      const db = initDb(dbPath);
      createPluginTables(db);
      createSearchTables(db);

      const app = createApp();
      const headers = await setupAuth(app);
      const bootstrap = await bootstrapVault(app, headers, workingVaultPath);
      const selectedPlugins = await configurePlugins(app, headers, options.plugins);

      const runAll = await requestJson<{
        batch_id: string;
        batch: {
          items: Array<{ plugin_id: string; plugin_name: string; run_id: string | null; status: string; error_message: string | null }>;
        };
      }>(app, 'POST', '/plugins/run-all', undefined, headers);

      const batch = await waitForBatchCompletion(app, headers, runAll.data.batch_id);
      const pluginResults: AutomationLoopPluginResult[] = [];

      for (const item of batch.items) {
        let detailPath: string | null = null;
        if (item.run_id) {
          const detail = await requestJson<PluginRunDetailResponse>(app, 'GET', `/plugins/runs/${item.run_id}`, undefined, headers);
          detailPath = path.join(runsPath, `${item.plugin_id}.json`);
          fs.writeFileSync(detailPath, `${JSON.stringify(detail.data, null, 2)}\n`, 'utf8');
        }

        pluginResults.push({
          pluginId: item.plugin_id,
          pluginName: item.plugin_name,
          status: item.status,
          errorMessage: item.error_message,
          runId: item.run_id,
          detailPath,
        });
      }

      writeDiff(sourcePath, workingVaultPath, diffPath);
      const changedFiles = listChangedFiles(sourcePath, workingVaultPath);

      const report = {
        source_path: sourcePath,
        working_vault_path: workingVaultPath,
        models_path: modelsPath,
        selected_plugins: selectedPlugins,
        bootstrap_sync: bootstrap,
        batch,
        changed_files: changedFiles,
        plugin_results: pluginResults,
      };
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

      const result: AutomationLoopResult = {
        sourcePath,
        runDir,
        workingVaultPath,
        diffPath,
        summaryPath,
        reportPath,
        pluginResults,
        changedFiles,
      };
      writeSummary(summaryPath, result);
      return result;
    });
  } finally {
    closeDb();
    resetLocalPluginRegistrations();
  }
}
