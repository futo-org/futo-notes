import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { validateTitle } from '@futo-notes/shared';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { getNote, type NoteRow } from '../db/notes.js';
import { broadcastSyncAvailable, broadcastTransformStatus } from '../events.js';
import { log } from '../logger.js';
import { isWithinIdleWindow } from '../search/scheduler.js';
import { tryAcquire, release, holder } from '../schedulerLock.js';
import { contentHash } from '../sync/hash.js';
import { deleteNoteFile, readNoteFile, resolveFilename, sanitizeFilename, writeNoteFile } from '../sync/files.js';
import { upsertNote } from '../db/notes.js';
import { getGenerateFn, getGenerationModelInfo, loadGenerationModel, unloadGenerationModel } from '../transforms/generationModel.js';
import { executeCodePlugin, getPendingNotesForCodePlugin } from './codeRuntime.js';
import { getPlugin, getPluginInstallRecord, isRestrictedModeEnabled, listPlugins } from './loader.js';
import type { LoadedPlugin, PluginAction, PluginPermission, PluginResult } from './types.js';

export type PluginSchedulerPhase =
  | 'idle'
  | 'downloading_model'
  | 'loading_model'
  | 'running'
  | 'disabled';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let running = false;
let currentConfig: Config | null = null;
let phase: PluginSchedulerPhase = 'idle';
let downloadProgress: { totalSize: number; downloadedSize: number } | null = null;
let abortController: AbortController | null = null;
let lastActivity = Date.now();
let lastError: string | null = null;

const FREQUENCY_MS: Record<string, number> = {
  manual: Number.POSITIVE_INFINITY,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function hasPermission(plugin: LoadedPlugin, permission: PluginPermission): boolean {
  return plugin.manifest.permissions.includes(permission);
}

function isDeclarativePlugin(plugin: LoadedPlugin): boolean {
  return (plugin.manifest.execution ?? 'full-trust') === 'declarative';
}

function isBlockedByRestrictedMode(db: Database.Database, plugin: LoadedPlugin): boolean {
  return plugin.origin === 'installed'
    && (plugin.manifest.execution ?? 'full-trust') === 'full-trust'
    && isRestrictedModeEnabled(db);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function extractFirstJson(text: string): string | null {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseActions(raw: string): PluginAction[] {
  const jsonText = extractFirstJson(raw);
  if (!jsonText) {
    throw new Error('Model did not return a JSON object');
  }

  const parsed = JSON.parse(jsonText) as { actions?: unknown };
  if (!Array.isArray(parsed.actions)) {
    throw new Error('Model JSON must include an actions array');
  }

  const actions: PluginAction[] = [];
  for (const action of parsed.actions) {
    if (!action || typeof action !== 'object') {
      throw new Error('Plugin action must be an object');
    }

    const type = (action as { type?: unknown }).type;
    if (type === 'rename_note') {
      const newTitle = (action as { new_title?: unknown }).new_title;
      if (typeof newTitle !== 'string' || newTitle.trim().length === 0) {
        throw new Error('rename_note action requires a non-empty new_title');
      }
      actions.push({ type, new_title: newTitle.trim() });
    } else if (type === 'edit_note_content') {
      const newContent = (action as { new_content?: unknown }).new_content;
      if (typeof newContent !== 'string') {
        throw new Error('edit_note_content action requires new_content');
      }
      actions.push({ type, new_content: newContent });
    } else {
      throw new Error(`Unsupported plugin action type "${String(type)}"`);
    }
  }

  return actions;
}

function selectorMatches(plugin: LoadedPlugin, note: NoteRow, content: string | null, force: boolean): boolean {
  const selector = plugin.manifest.selector;
  if (!selector) return true;

  if (!force && typeof selector.stale_minutes === 'number') {
    const cutoff = Date.now() - selector.stale_minutes * 60_000;
    if (note.modified_at >= cutoff) {
      return false;
    }
  }

  if (selector.filename_glob && !globToRegExp(selector.filename_glob).test(note.filename)) {
    return false;
  }
  if (selector.exclude_filename_glob && globToRegExp(selector.exclude_filename_glob).test(note.filename)) {
    return false;
  }
  if (selector.filename_regex && !new RegExp(selector.filename_regex).test(note.filename)) {
    return false;
  }
  if (selector.exclude_filename_regex && new RegExp(selector.exclude_filename_regex).test(note.filename)) {
    return false;
  }
  if (typeof selector.min_content_chars === 'number') {
    const text = content ?? '';
    if (text.trim().length < selector.min_content_chars) {
      return false;
    }
  }

  return true;
}

async function getPendingNoteIds(
  db: Database.Database,
  plugin: LoadedPlugin,
  notesPath: string,
  opts?: { force?: boolean },
): Promise<string[]> {
  if (!isDeclarativePlugin(plugin)) {
    return getPendingNotesForCodePlugin(plugin, db, notesPath, opts?.force ?? false);
  }

  const rows = db.prepare(`
    SELECT uuid, filename, content_hash, modified_at, created_at
    FROM notes
    ORDER BY modified_at ASC
  `).all() as NoteRow[];

  const stateRows = db.prepare(`
    SELECT uuid, content_hash
    FROM transform_state
    WHERE transform_id = ?
  `).all(plugin.manifest.id) as { uuid: string; content_hash: string }[];
  const stateByUuid = new Map(stateRows.map((row) => [row.uuid, row.content_hash]));

  const force = opts?.force ?? false;
  const reprocessOnContentChange = plugin.manifest.selector?.reprocess_on_content_change ?? true;
  const pending: string[] = [];

  for (const note of rows) {
    const content = plugin.manifest.selector?.min_content_chars ? readNoteFile(notesPath, note.filename) : null;
    if (!selectorMatches(plugin, note, content, force)) {
      continue;
    }

    const previousHash = stateByUuid.get(note.uuid);
    if (reprocessOnContentChange) {
      if (previousHash === note.content_hash) continue;
    } else if (previousHash) {
      continue;
    }

    pending.push(note.uuid);
    if (plugin.manifest.selector?.max_notes_per_run && pending.length >= plugin.manifest.selector.max_notes_per_run) {
      break;
    }
  }

  return pending;
}

function getLastSuccessfulRun(db: Database.Database, pluginId: string): number | null {
  const row = db.prepare(`
    SELECT finished_at
    FROM transform_jobs
    WHERE transform_id = ? AND status = 'completed'
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(pluginId) as { finished_at: number | null } | undefined;
  return row?.finished_at ?? null;
}

function isPluginEnabled(pluginId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT enabled FROM plugin_installs WHERE plugin_id = ?').get(pluginId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function isPluginDue(db: Database.Database, plugin: LoadedPlugin): boolean {
  const frequency = plugin.manifest.frequency ?? 'manual';
  if (frequency === 'manual') return false;

  const lastRun = getLastSuccessfulRun(db, plugin.manifest.id);
  if (lastRun === null) return true;
  return Date.now() - lastRun >= FREQUENCY_MS[frequency];
}

function recordPluginState(
  db: Database.Database,
  pluginId: string,
  uuid: string,
  hash: string,
  result: string,
): void {
  db.prepare(`
    INSERT INTO transform_state (transform_id, uuid, content_hash, processed_at, result)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(transform_id, uuid) DO UPDATE SET
      content_hash = excluded.content_hash,
      processed_at = excluded.processed_at,
      result = excluded.result
  `).run(pluginId, uuid, hash, Date.now(), result);
}

function buildUserPrompt(plugin: LoadedPlugin, note: NoteRow, content: string, db: Database.Database): string {
  const runtime = plugin.manifest.runtime ?? {};
  const maxChars = typeof runtime.max_content_chars === 'number' && runtime.max_content_chars > 0
    ? runtime.max_content_chars
    : content.length;
  const snippet = content.slice(0, maxChars);

  const context: Record<string, unknown> = {
    note: {
      uuid: note.uuid,
      filename: note.filename,
      title: note.filename.replace(/\.md$/i, ''),
      modified_at: note.modified_at,
      content: snippet,
      content_truncated: snippet.length < content.length,
    },
  };

  if (typeof runtime.include_recent_titles === 'number' && runtime.include_recent_titles > 0) {
    const rows = db.prepare(`
      SELECT filename FROM notes
      WHERE uuid != ? AND filename NOT GLOB 'Untitled*.md'
      ORDER BY modified_at DESC
      LIMIT ?
    `).all(note.uuid, runtime.include_recent_titles) as { filename: string }[];
    context.recent_titles = rows.map((row) => row.filename.replace(/\.md$/, ''));
  }

  return [
    `Plugin metadata:`,
    JSON.stringify({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      description: plugin.manifest.description,
      permissions: plugin.manifest.permissions,
      frequency: plugin.manifest.frequency ?? 'manual',
    }, null, 2),
    '',
    'Plugin instructions:',
    (plugin.source ?? '').trim(),
    '',
    'Note context:',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function buildSystemPrompt(plugin: LoadedPlugin): string {
  return [
    'You are executing a Stonefruit note automation plugin.',
    'Return valid JSON only. Do not use markdown code fences.',
    'The top-level shape must be {"actions":[...]}',
    'If no change should be made, return {"actions":[]}.',
    'Allowed actions are limited to the plugin permissions declared below.',
    `Allowed permissions: ${plugin.manifest.permissions.join(', ')}`,
    'Action schema:',
    '- rename_note => {"type":"rename_note","new_title":"string"}',
    '- edit_note_content => {"type":"edit_note_content","new_content":"string"}',
    'Never emit actions that are not explicitly permitted.',
  ].join('\n');
}

async function executePluginOnNote(
  db: Database.Database,
  notesPath: string,
  plugin: LoadedPlugin,
  noteUuid: string,
  force: boolean,
  signal: AbortSignal,
): Promise<PluginResult[]> {
  const note = getNote(db, noteUuid);
  if (!note) return [];

  const content = readNoteFile(notesPath, note.filename);
  if (content === null) return [];

  if (!selectorMatches(plugin, note, content, force)) {
    return [];
  }

  const generate = getGenerateFn();
  if (!generate) {
    throw new Error('Generation model not available');
  }

  const runtime = plugin.manifest.runtime ?? {};
  const raw = await generate(buildUserPrompt(plugin, note, content, db), {
    systemPrompt: buildSystemPrompt(plugin),
    maxTokens: typeof runtime.max_tokens === 'number' ? runtime.max_tokens : 256,
    temperature: typeof runtime.temperature === 'number' ? runtime.temperature : 0.2,
    thinking: false,
    signal,
  });

  const actions = parseActions(raw);
  const renameActions = actions.filter((action) => action.type === 'rename_note');
  const editActions = actions.filter((action) => action.type === 'edit_note_content');

  if (renameActions.length > 1 || editActions.length > 1) {
    throw new Error('Plugin returned duplicate actions for a single note');
  }

  if (renameActions.length > 0 && !hasPermission(plugin, 'rename_note')) {
    throw new Error(`Plugin "${plugin.manifest.id}" attempted rename_note without permission`);
  }
  if (editActions.length > 0 && !hasPermission(plugin, 'edit_note_content')) {
    throw new Error(`Plugin "${plugin.manifest.id}" attempted edit_note_content without permission`);
  }

  const rename = renameActions[0];
  const edit = editActions[0];

  let finalFilename = note.filename;
  let finalContent = content;
  const results: PluginResult[] = [];

  if (rename) {
    const title = rename.new_title.trim().replace(/\.md$/i, '');
    const issues = validateTitle(title);
    if (issues.length > 0) {
      throw new Error(`Plugin proposed invalid title: ${issues.map((issue) => issue.kind).join(', ')}`);
    }
    finalFilename = resolveFilename(db, sanitizeFilename(`${title}.md`), note.uuid);
  }

  if (edit) {
    finalContent = edit.new_content;
  }

  if (finalFilename === note.filename && finalContent === content) {
    recordPluginState(db, plugin.manifest.id, note.uuid, note.content_hash, 'no_change');
    return [];
  }

  const now = Date.now();
  const nextHash = contentHash(finalContent);

  if (finalFilename !== note.filename) {
    writeNoteFile(notesPath, finalFilename, finalContent, now);
    deleteNoteFile(notesPath, note.filename);
    db.prepare(`
      INSERT INTO transform_history (transform_id, uuid, action, old_filename, new_filename, executed_at)
      VALUES (?, ?, 'rename_note', ?, ?, ?)
    `).run(plugin.manifest.id, note.uuid, note.filename, finalFilename, now);
    results.push({
      noteUuid,
      action: 'rename_note',
      oldFilename: note.filename,
      newFilename: finalFilename,
    });
  } else {
    writeNoteFile(notesPath, note.filename, finalContent, now);
  }

  if (edit) {
    db.prepare(`
      INSERT INTO transform_history (transform_id, uuid, action, old_filename, new_filename, executed_at)
      VALUES (?, ?, 'edit_note_content', ?, ?, ?)
    `).run(plugin.manifest.id, note.uuid, finalFilename, finalFilename, now);
    results.push({
      noteUuid,
      action: 'edit_note_content',
      oldFilename: finalFilename,
      newFilename: finalFilename,
    });
  }

  upsertNote(db, note.uuid, finalFilename, nextHash, now);
  recordPluginState(
    db,
    plugin.manifest.id,
    note.uuid,
    nextHash,
    results.map((result) => result.action).join(','),
  );

  return results;
}

async function executePluginBatch(
  db: Database.Database,
  notesPath: string,
  plugin: LoadedPlugin,
  batch: string[],
  signal: AbortSignal,
): Promise<PluginResult[]> {
  if (!isDeclarativePlugin(plugin)) {
    const generate = getGenerateFn();
    if (!generate) {
      throw new Error('Generation model not available');
    }
    return executeCodePlugin(plugin, db, notesPath, batch, generate, signal);
  }

  const results: PluginResult[] = [];
  for (const uuid of batch) {
    if (signal.aborted) break;
    results.push(...await executePluginOnNote(db, notesPath, plugin, uuid, false, signal));
  }
  return results;
}

interface PluginJobResult {
  jobId: string;
  pluginId: string;
  status: 'completed' | 'failed' | 'interrupted';
  notesProcessed: number;
  notesTotal: number;
  results: PluginResult[];
  error?: string;
}

async function runPluginJob(
  db: Database.Database,
  plugin: LoadedPlugin,
  notesPath: string,
  batchSize: number,
  signal: AbortSignal,
  opts?: { force?: boolean },
): Promise<PluginJobResult> {
  const jobId = crypto.randomUUID();
  const pendingUuids = await getPendingNoteIds(db, plugin, notesPath, { force: opts?.force });
  const force = opts?.force ?? false;

  if (pendingUuids.length === 0) {
    return { jobId, pluginId: plugin.manifest.id, status: 'completed', notesProcessed: 0, notesTotal: 0, results: [] };
  }

  const interrupted = db.prepare(`
    SELECT job_id, checkpoint FROM transform_jobs
    WHERE transform_id = ? AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `).get(plugin.manifest.id) as { job_id: string; checkpoint: string | null } | undefined;

  let skipSet = new Set<string>();
  if (interrupted) {
    db.prepare(`UPDATE transform_jobs SET status = 'interrupted', finished_at = ? WHERE job_id = ?`)
      .run(Date.now(), interrupted.job_id);
    if (interrupted.checkpoint) {
      try {
        skipSet = new Set(JSON.parse(interrupted.checkpoint) as string[]);
      } catch {
        skipSet = new Set();
      }
    }
  }

  const uuidsToProcess = pendingUuids.filter((uuid) => !skipSet.has(uuid));
  const notesTotal = uuidsToProcess.length;
  if (notesTotal === 0) {
    return { jobId, pluginId: plugin.manifest.id, status: 'completed', notesProcessed: 0, notesTotal: 0, results: [] };
  }

  db.prepare(`
    INSERT INTO transform_jobs (job_id, transform_id, status, started_at, notes_total, notes_processed)
    VALUES (?, ?, 'running', ?, ?, 0)
  `).run(jobId, plugin.manifest.id, Date.now(), notesTotal);

  const processedUuids = [...skipSet];
  let notesProcessed = 0;
  const allResults: PluginResult[] = [];

  try {
    for (let i = 0; i < uuidsToProcess.length; i += batchSize) {
      if (signal.aborted) {
        db.prepare(`UPDATE transform_jobs SET status = 'interrupted', finished_at = ? WHERE job_id = ?`)
          .run(Date.now(), jobId);
        return { jobId, pluginId: plugin.manifest.id, status: 'interrupted', notesProcessed, notesTotal, results: allResults };
      }

      const batch = uuidsToProcess.slice(i, i + batchSize);
      const results: PluginResult[] = [];
      if (isDeclarativePlugin(plugin)) {
        for (const uuid of batch) {
          if (signal.aborted) break;
          results.push(...await executePluginOnNote(db, notesPath, plugin, uuid, force, signal));
        }
      } else {
        results.push(...await executePluginBatch(db, notesPath, plugin, batch, signal));
      }
      allResults.push(...results);
      for (const uuid of batch) {
        processedUuids.push(uuid);
        notesProcessed += 1;
      }

      db.prepare(`
        UPDATE transform_jobs SET notes_processed = ?, checkpoint = ? WHERE job_id = ?
      `).run(notesProcessed, JSON.stringify(processedUuids), jobId);
    }

    db.prepare(`UPDATE transform_jobs SET status = 'completed', finished_at = ? WHERE job_id = ?`)
      .run(Date.now(), jobId);
    return { jobId, pluginId: plugin.manifest.id, status: 'completed', notesProcessed, notesTotal, results: allResults };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE transform_jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE job_id = ?`)
      .run(Date.now(), message, jobId);
    return { jobId, pluginId: plugin.manifest.id, status: 'failed', notesProcessed, notesTotal, results: allResults, error: message };
  }
}

/** Record plugin-specific activity for idle tracking. */
export function recordPluginActivity(): void {
  lastActivity = Date.now();
}

export function getPluginSchedulerState(): {
  phase: PluginSchedulerPhase;
  running: boolean;
  downloadProgress: { totalSize: number; downloadedSize: number } | null;
} {
  return {
    phase,
    running,
    downloadProgress: phase === 'downloading_model' ? downloadProgress : null,
  };
}

async function tick(): Promise<void> {
  if (running || !currentConfig) return;

  const config = currentConfig;
  const inWindow = isWithinIdleWindow(config.indexIdleStart, config.indexIdleEnd);
  const idleMs = Date.now() - lastActivity;
  const idleThresholdMs = 3 * 60 * 60 * 1000;
  if (!inWindow && idleMs < idleThresholdMs) return;

  const db = getDb();
  const plugins = listPlugins(db, config);
  const eligible = plugins.filter((plugin) => isPluginEnabled(plugin.manifest.id) && isPluginDue(db, plugin) && !isBlockedByRestrictedMode(db, plugin));
  const enabledWithWork: { plugin: LoadedPlugin; pendingCount: number }[] = [];
  for (const plugin of eligible) {
    const pendingCount = (await getPendingNoteIds(db, plugin, config.notesPath)).length;
    if (pendingCount > 0) {
      enabledWithWork.push({ plugin, pendingCount });
    }
  }

  if (enabledWithWork.length === 0) return;
  if (!tryAcquire('transforms')) return;

  running = true;
  abortController = new AbortController();
  let hadChanges = false;

  try {
    phase = 'loading_model';
    downloadProgress = null;
    broadcastTransformStatus();

    await loadGenerationModel(config.modelsPath, {
      onDownloadProgress: (status) => {
        phase = 'downloading_model';
        downloadProgress = status;
        broadcastTransformStatus();
      },
      onDownloadComplete: () => {
        phase = 'loading_model';
        downloadProgress = null;
        broadcastTransformStatus();
      },
    });

    phase = 'running';
    broadcastTransformStatus();

    for (const { plugin } of enabledWithWork) {
      if (abortController.signal.aborted) break;
      const result = await runPluginJob(db, plugin, config.notesPath, config.indexBatchSize, abortController.signal);
      if (result.results.length > 0) {
        hadChanges = true;
      }
    }

    await unloadGenerationModel();
    if (hadChanges) {
      broadcastSyncAvailable();
    }
    lastError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`plugins: scheduler error: ${message}`);
    lastError = message;
  } finally {
    running = false;
    phase = 'idle';
    downloadProgress = null;
    abortController = null;
    release('transforms');
    broadcastTransformStatus();
  }
}

export function triggerPluginNow(pluginId: string): void {
  if (!currentConfig) {
    throw new Error('Plugin scheduler not initialized');
  }
  if (running) {
    throw new Error('Plugin job already running');
  }
  if (!tryAcquire('transforms')) {
    throw new Error(`Cannot run plugin: ${holder()} job is in progress`);
  }

  const config = currentConfig;
  const db = getDb();
  const plugin = getPlugin(db, config, pluginId);
  if (!plugin) {
    release('transforms');
    throw new Error(`Unknown plugin: ${pluginId}`);
  }
  if (isBlockedByRestrictedMode(db, plugin)) {
    release('transforms');
    throw new Error(`Plugin "${pluginId}" is blocked by restricted mode`);
  }

  running = true;
  abortController = new AbortController();

  void (async () => {
    let hadChanges = false;
    try {
      phase = 'loading_model';
      downloadProgress = null;
      broadcastTransformStatus();

      await loadGenerationModel(config.modelsPath, {
        onDownloadProgress: (status) => {
          phase = 'downloading_model';
          downloadProgress = status;
          broadcastTransformStatus();
        },
        onDownloadComplete: () => {
          phase = 'loading_model';
          downloadProgress = null;
          broadcastTransformStatus();
        },
      });

      phase = 'running';
      broadcastTransformStatus();

      const result = await runPluginJob(db, plugin, config.notesPath, config.indexBatchSize, abortController!.signal, { force: true });
      hadChanges = result.results.length > 0;

      await unloadGenerationModel();
      if (hadChanges) {
        broadcastSyncAvailable();
      }
      lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`plugins: manual trigger failed for "${pluginId}": ${message}`);
      lastError = message;
    } finally {
      running = false;
      phase = 'idle';
      downloadProgress = null;
      abortController = null;
      release('transforms');
      broadcastTransformStatus();
    }
  })();
}

export async function getPendingCount(pluginId: string): Promise<number> {
  const config = currentConfig ?? loadConfig();
  const db = getDb();
  const plugin = getPlugin(db, config, pluginId);
  if (!plugin) return 0;
  return (await getPendingNoteIds(db, plugin, config.notesPath)).length;
}

export async function getPluginsStatus(): Promise<{
  plugins: {
    id: string;
    name: string;
    version: string;
    publisher: string;
    description: string;
    permissions: string[];
    frequency: string;
    kind: string;
    execution: string;
    origin: string;
    enabled: boolean;
    trusted: boolean;
    installed_from: string | null;
    blocked_by_restricted_mode: boolean;
    pending_count: number;
    last_run: { status: string; finished_at: number | null; notes_processed: number; error_message: string | null } | null;
    updatable: boolean;
  }[];
  model: { id: string; loaded: boolean; download_progress: { totalSize: number; downloadedSize: number } | null };
  scheduler: { phase: PluginSchedulerPhase; running: boolean; last_error: string | null };
  security: { restricted_mode: boolean };
}> {
  const db = getDb();
  const config = currentConfig ?? loadConfig();
  const plugins = listPlugins(db, config);
  const modelInfo = getGenerationModelInfo();
  const restrictedMode = isRestrictedModeEnabled(db);

  const statuses = await Promise.all(plugins.map(async (plugin) => {
    const record = getPluginInstallRecord(db, plugin.manifest.id);
    const blocked = isBlockedByRestrictedMode(db, plugin);
    const lastRun = db.prepare(`
      SELECT status, finished_at, notes_processed, error_message
      FROM transform_jobs
      WHERE transform_id = ? AND status IN ('completed', 'failed')
      ORDER BY finished_at DESC
      LIMIT 1
    `).get(plugin.manifest.id) as { status: string; finished_at: number | null; notes_processed: number; error_message: string | null } | undefined;

    return {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      publisher: plugin.manifest.publisher,
      description: plugin.manifest.description,
      permissions: plugin.manifest.permissions,
      frequency: plugin.manifest.frequency ?? 'manual',
      kind: plugin.manifest.kind,
      execution: plugin.manifest.execution ?? 'full-trust',
      origin: plugin.origin,
      enabled: record?.enabled === 1,
      trusted: record?.trusted === 1,
      installed_from: record?.manifest_url ?? null,
      blocked_by_restricted_mode: blocked,
      pending_count: blocked ? 0 : (await getPendingNoteIds(db, plugin, config.notesPath)).length,
      last_run: lastRun ? {
        status: lastRun.status,
        finished_at: lastRun.finished_at,
        notes_processed: lastRun.notes_processed,
        error_message: lastRun.error_message,
      } : null,
      updatable: plugin.origin === 'installed' && Boolean(record?.manifest_url),
    };
  }));

  return {
    plugins: statuses,
    model: {
      id: modelInfo.id,
      loaded: modelInfo.loaded,
      download_progress: phase === 'downloading_model' ? downloadProgress : null,
    },
    scheduler: { phase, running, last_error: lastError },
    security: { restricted_mode: restrictedMode },
  };
}

export function startPluginScheduler(config: Config): void {
  currentConfig = config;
  schedulerInterval = setInterval(() => {
    tick().catch((err) => {
      log.error(`plugins: scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 60_000);
  schedulerInterval.unref();
  log.info('plugins: scheduler started');
}

export function stopPluginScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  abortController?.abort();
  running = false;
  release('transforms');
  currentConfig = null;
  downloadProgress = null;
  abortController = null;
}
