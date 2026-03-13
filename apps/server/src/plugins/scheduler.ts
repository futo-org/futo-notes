import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { broadcastPluginStatus } from '../events.js';
import { log } from '../logger.js';
import { tryAcquire, release, holder } from '../schedulerLock.js';
import { isWithinIdleWindow } from '../search/scheduler.js';
import { applyNoteMutationEffects } from '../sync/noteMutationEffects.js';
import { createPluginSdk } from './sdk.js';
import { getBuiltinLlmInfo, getBuiltinLlmRunner, loadBuiltinLlm, unloadBuiltinLlm } from './llm.js';
import { ensureLocalPluginsLoaded } from './local.js';
import { getPlugin, listPluginRegistrations, listPlugins } from './registry.js';
import type {
  BuiltinPlugin,
  PluginApplyMode,
  PluginConfigField,
  PluginRunItemRow,
  PluginRunRow,
  PluginRunStatus,
  PluginScheduleConfig,
  PluginStoredConfig,
  PluginTriggerType,
} from './types.js';

export type PluginSchedulerPhase =
  | 'idle'
  | 'downloading_model'
  | 'loading_model'
  | 'running'
  | 'disabled';

interface PluginDbRow {
  plugin_id: string;
  enabled: number;
  schedule_kind: PluginScheduleConfig['kind'];
  schedule_time: string | null;
  schedule_day: number | null;
  auto_apply: number;
  config_json: string;
  last_run_at: number | null;
  next_run_at: number | null;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let running = false;
let currentConfig: Config | null = null;
let phase: PluginSchedulerPhase = 'idle';
let downloadProgress: { totalSize: number; downloadedSize: number } | null = null;
let abortController: AbortController | null = null;
let lastActivity = Date.now();
let lastError: string | null = null;
type RunAllBatchItemStatus = 'queued' | 'running' | 'succeeded' | 'failed';
type RunAllBatchStatus = 'running' | 'completed';

interface RunAllBatchItem {
  pluginId: string;
  pluginName: string;
  status: RunAllBatchItemStatus;
  runId: string | null;
  runStatus: PluginRunStatus | null;
  errorMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

interface RunAllBatchState {
  batchId: string;
  status: RunAllBatchStatus;
  startedAt: number;
  finishedAt: number | null;
  currentPluginId: string | null;
  items: RunAllBatchItem[];
}

let runAllBatch: RunAllBatchState | null = null;

function cloneRunAllBatch(batch: RunAllBatchState | null): RunAllBatchState | null {
  if (!batch) return null;
  return {
    batchId: batch.batchId,
    status: batch.status,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    currentPluginId: batch.currentPluginId,
    items: batch.items.map((item) => ({
      pluginId: item.pluginId,
      pluginName: item.pluginName,
      status: item.status,
      runId: item.runId,
      runStatus: item.runStatus,
      errorMessage: item.errorMessage,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
    })),
  };
}

function serializeRunAllBatch(batch: RunAllBatchState | null): Record<string, unknown> | null {
  const copy = cloneRunAllBatch(batch);
  if (!copy) return null;
  return {
    batch_id: copy.batchId,
    status: copy.status,
    started_at: copy.startedAt,
    finished_at: copy.finishedAt,
    current_plugin_id: copy.currentPluginId,
    items: copy.items.map((item) => ({
      plugin_id: item.pluginId,
      plugin_name: item.pluginName,
      status: item.status,
      run_id: item.runId,
      run_status: item.runStatus,
      error_message: item.errorMessage,
      started_at: item.startedAt,
      finished_at: item.finishedAt,
    })),
  };
}

function createRunAllBatch(plugins: BuiltinPlugin[]): RunAllBatchState {
  return {
    batchId: crypto.randomUUID(),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    currentPluginId: null,
    items: plugins.map((plugin) => ({
      pluginId: plugin.id,
      pluginName: plugin.name,
      status: 'queued',
      runId: null,
      runStatus: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    })),
  };
}

async function getEnabledPlugins(
  db: Database.Database,
  config: Config,
): Promise<BuiltinPlugin[]> {
  await ensureLocalPluginsLoaded(db, config);
  ensurePluginRows(db);
  return listPlugins().filter((plugin) => getPluginStoredConfig(db, plugin).enabled);
}

function finalizeBatchItemFromRun(
  batchItem: RunAllBatchItem,
  run: PluginRunRow,
): void {
  batchItem.runStatus = run.status;
  batchItem.errorMessage = run.error_message;
  batchItem.finishedAt = run.finished_at ?? Date.now();
  batchItem.status = run.status === 'failed' ? 'failed' : 'succeeded';
}

function defaultConfigFor(plugin: BuiltinPlugin): Record<string, unknown> {
  return Object.fromEntries(plugin.configSchema.map((field) => [field.key, field.default]));
}

function nextScheduledAt(schedule: PluginScheduleConfig, now = new Date()): number | null {
  if (schedule.kind === 'manual') return null;

  const time = schedule.time ?? '03:00';
  const [hoursRaw, minutesRaw] = time.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hours, minutes, 0, 0);

  if (schedule.kind === 'daily') {
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  const targetDay = schedule.day ?? 1;
  const currentDay = next.getDay();
  let delta = targetDay - currentDay;
  if (delta < 0) delta += 7;
  next.setDate(next.getDate() + delta);
  if (delta === 0 && next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 7);
  }
  return next.getTime();
}

function ensurePluginRows(db: Database.Database): void {
  const now = Date.now();
  for (const entry of listPluginRegistrations()) {
    const plugin = entry.plugin;
    db.prepare(`
      INSERT INTO plugins (
        plugin_id, enabled, schedule_kind, schedule_time, schedule_day,
        auto_apply, config_json, last_run_at, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(plugin_id) DO NOTHING
    `).run(
      plugin.id,
      plugin.defaultEnabled ? 1 : 0,
      plugin.defaultSchedule.kind,
      plugin.defaultSchedule.time ?? null,
      plugin.defaultSchedule.day ?? null,
      plugin.defaultAutoApply ? 1 : 0,
      JSON.stringify(defaultConfigFor(plugin)),
      plugin.defaultEnabled ? nextScheduledAt(plugin.defaultSchedule) : null,
      now,
      now,
    );
  }
}

function mergePluginConfig(plugin: BuiltinPlugin, raw: string): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const merged = defaultConfigFor(plugin);
  for (const field of plugin.configSchema) {
    if (field.key in parsed) {
      merged[field.key] = parsed[field.key];
    }
  }
  return merged;
}

function getPluginRow(db: Database.Database, pluginId: string): PluginDbRow {
  ensurePluginRows(db);
  const row = db.prepare(`
    SELECT plugin_id, enabled, schedule_kind, schedule_time, schedule_day, auto_apply, config_json, last_run_at, next_run_at
    FROM plugins
    WHERE plugin_id = ?
  `).get(pluginId) as PluginDbRow | undefined;
  if (!row) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }
  return row;
}

function getPluginStoredConfig(db: Database.Database, plugin: BuiltinPlugin): PluginStoredConfig {
  const row = getPluginRow(db, plugin.id);
  return {
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    scheduleKind: row.schedule_kind,
    scheduleTime: row.schedule_time,
    scheduleDay: row.schedule_day,
    autoApply: row.auto_apply === 1,
    config: mergePluginConfig(plugin, row.config_json),
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

function updatePluginRow(
  db: Database.Database,
  pluginId: string,
  input: Partial<{
    enabled: boolean;
    scheduleKind: PluginScheduleConfig['kind'];
    scheduleTime: string | null;
    scheduleDay: number | null;
    autoApply: boolean;
    configJson: string;
    lastRunAt: number | null;
    nextRunAt: number | null;
  }>,
): void {
  const existing = getPluginRow(db, pluginId);
  const nextSchedule = {
    kind: input.scheduleKind ?? existing.schedule_kind,
    time: input.scheduleTime === undefined ? existing.schedule_time : input.scheduleTime,
    day: input.scheduleDay === undefined ? existing.schedule_day : input.scheduleDay,
  };
  const enabled = input.enabled === undefined ? existing.enabled === 1 : input.enabled;

  db.prepare(`
    UPDATE plugins
    SET enabled = ?,
        schedule_kind = ?,
        schedule_time = ?,
        schedule_day = ?,
        auto_apply = ?,
        config_json = ?,
        last_run_at = ?,
        next_run_at = ?,
        updated_at = ?
    WHERE plugin_id = ?
  `).run(
    enabled ? 1 : 0,
    nextSchedule.kind,
    nextSchedule.time ?? null,
    nextSchedule.day ?? null,
    (input.autoApply === undefined ? existing.auto_apply === 1 : input.autoApply) ? 1 : 0,
    input.configJson ?? existing.config_json,
    input.lastRunAt === undefined ? existing.last_run_at : input.lastRunAt,
    input.nextRunAt === undefined ? (enabled ? nextScheduledAt(nextSchedule) : null) : input.nextRunAt,
    Date.now(),
    pluginId,
  );
}

function parseRunSummary(summaryJson: string | null): Record<string, unknown> | null {
  if (!summaryJson) return null;
  try {
    return JSON.parse(summaryJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function createRunRow(db: Database.Database, pluginId: string, triggerType: PluginTriggerType, applyMode: PluginApplyMode): string {
  const runId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO plugin_runs (run_id, plugin_id, trigger_type, apply_mode, status, started_at)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(runId, pluginId, triggerType, applyMode, Date.now());
  return runId;
}

function updateRun(
  db: Database.Database,
  runId: string,
  input: Partial<{
    status: PluginRunStatus;
    finishedAt: number | null;
    errorMessage: string | null;
    summaryJson: string | null;
  }>,
): void {
  const current = db.prepare(`
    SELECT status, finished_at, error_message, summary_json
    FROM plugin_runs
    WHERE run_id = ?
  `).get(runId) as { status: PluginRunStatus; finished_at: number | null; error_message: string | null; summary_json: string | null } | undefined;
  if (!current) {
    throw new Error(`Unknown run: ${runId}`);
  }

  db.prepare(`
    UPDATE plugin_runs
    SET status = ?, finished_at = ?, error_message = ?, summary_json = ?
    WHERE run_id = ?
  `).run(
    input.status ?? current.status,
    input.finishedAt === undefined ? current.finished_at : input.finishedAt,
    input.errorMessage === undefined ? current.error_message : input.errorMessage,
    input.summaryJson === undefined ? current.summary_json : input.summaryJson,
    runId,
  );
}

function listRunItems(db: Database.Database, runId: string): PluginRunItemRow[] {
  return db.prepare(`
    SELECT *
    FROM plugin_run_items
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId) as PluginRunItemRow[];
}

function getRunRow(db: Database.Database, runId: string): PluginRunRow {
  const row = db.prepare(`
    SELECT *
    FROM plugin_runs
    WHERE run_id = ?
  `).get(runId) as PluginRunRow | undefined;
  if (!row) {
    throw new Error(`Unknown run: ${runId}`);
  }
  return row;
}

async function applyApprovedItemsInternal(
  db: Database.Database,
  config: Config,
  plugin: BuiltinPlugin,
  runId: string,
): Promise<{ appliedCount: number; failedCount: number; changedUuids: string[]; deletedUuids: string[] }> {
  const runner = async () => {
    throw new Error('LLM access is not available during apply-only execution');
  };
  const sdk = createPluginSdk(db, config.notesPath, plugin.id, runId, runner);
  const approvedItems = db.prepare(`
    SELECT *
    FROM plugin_run_items
    WHERE run_id = ? AND status = 'approved'
    ORDER BY id ASC
  `).all(runId) as PluginRunItemRow[];

  let appliedCount = 0;
  let failedCount = 0;
  const changedUuids = new Set<string>();
  const deletedUuids = new Set<string>();

  for (const item of approvedItems) {
    const after = parseJsonObject(item.after_json);
    try {
      let nextAfter = { ...after };
      if (item.change_type === 'rename_note') {
        const renameResult = await sdk.renameNote({
          noteUuid: item.entity_id,
          newTitle: String(after.newTitle ?? ''),
          rewriteExactWikiLinks: after.rewriteExactWikiLinks !== false,
        });
        for (const uuid of renameResult.changedUuids) {
          changedUuids.add(uuid);
        }
        for (const uuid of renameResult.deletedUuids) {
          deletedUuids.add(uuid);
        }

        nextAfter = {
          ...after,
          finalTitle: renameResult.finalTitle,
          finalFilename: renameResult.finalFilename,
          rewrittenNotes: renameResult.rewrittenNotes,
        };
      } else if (item.change_type === 'merge_note_into_list') {
        const mergeResult = await sdk.mergeNoteIntoList({
          sourceNoteUuid: item.entity_id,
          destinationNoteUuid: typeof after.destinationNoteUuid === 'string' ? after.destinationNoteUuid : null,
          destinationTitle: String(after.destinationTitle ?? ''),
          insertedListText: String(after.insertedListText ?? ''),
          fallbackUsed: after.fallbackUsed === true,
        });
        for (const uuid of mergeResult.changedUuids) {
          changedUuids.add(uuid);
        }
        for (const uuid of mergeResult.deletedUuids) {
          deletedUuids.add(uuid);
        }

        nextAfter = {
          ...after,
          destinationUuid: mergeResult.destinationUuid,
          destinationTitle: mergeResult.destinationTitle,
          destinationFilename: mergeResult.destinationFilename,
          destinationCreated: mergeResult.destinationCreated,
          sourceDeleted: mergeResult.sourceDeleted,
        };
      } else if (item.change_type === 'replace_managed_block') {
        const replaceResult = await sdk.replaceManagedBlock({
          noteUuid: item.entity_id,
          blockId: String(after.blockId ?? ''),
          content: String(after.content ?? ''),
        });
        for (const uuid of replaceResult.changedUuids) {
          changedUuids.add(uuid);
        }
        for (const uuid of replaceResult.deletedUuids) {
          deletedUuids.add(uuid);
        }

        nextAfter = {
          ...after,
          renderedBlock: replaceResult.renderedBlock,
          changed: replaceResult.changed,
          filename: replaceResult.filename,
        };
      } else {
        throw new Error(`Unsupported change type: ${item.change_type}`);
      }

      db.prepare(`
        UPDATE plugin_run_items
        SET status = 'applied',
            after_json = ?,
            failure_message = NULL,
            applied_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(nextAfter), Date.now(), Date.now(), item.id);
      appliedCount += 1;
    } catch (err) {
      failedCount += 1;
      db.prepare(`
        UPDATE plugin_run_items
        SET status = 'failed',
            failure_message = ?,
            updated_at = ?
        WHERE id = ?
      `).run(err instanceof Error ? err.message : String(err), Date.now(), item.id);
    }
  }

  return {
    appliedCount,
    failedCount,
    changedUuids: Array.from(changedUuids),
    deletedUuids: Array.from(deletedUuids),
  };
}

function refreshRunTerminalStatus(db: Database.Database, runId: string): PluginRunStatus {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'suggested' THEN 1 ELSE 0 END) AS suggested_count,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
    FROM plugin_run_items
    WHERE run_id = ?
  `).get(runId) as { suggested_count: number | null; approved_count: number | null; failed_count: number | null };

  const suggestedCount = counts.suggested_count ?? 0;
  const approvedCount = counts.approved_count ?? 0;
  const failedCount = counts.failed_count ?? 0;

  if (failedCount > 0) {
    updateRun(db, runId, { status: 'failed', finishedAt: Date.now() });
    return 'failed';
  }
  if (suggestedCount > 0 || approvedCount > 0) {
    updateRun(db, runId, { status: 'awaiting_approval', finishedAt: null });
    return 'awaiting_approval';
  }

  updateRun(db, runId, { status: 'succeeded', finishedAt: Date.now() });
  return 'succeeded';
}

async function executePluginRun(
  db: Database.Database,
  config: Config,
  plugin: BuiltinPlugin,
  triggerType: PluginTriggerType,
  opts?: { existingRunId?: string },
): Promise<string> {
  const stored = getPluginStoredConfig(db, plugin);
  const applyMode: PluginApplyMode = stored.autoApply ? 'auto_apply' : 'preview';
  const runId = opts?.existingRunId ?? createRunRow(db, plugin.id, triggerType, applyMode);

  try {
    phase = 'running';
    downloadProgress = null;
    broadcastPluginStatus();

    let llmRunner = getBuiltinLlmRunner();
    const lazyLlmRunner = async (input: Parameters<NonNullable<typeof llmRunner>>[0]) => {
      if (!llmRunner) {
        phase = 'loading_model';
        downloadProgress = null;
        broadcastPluginStatus();

        await loadBuiltinLlm(config.modelsPath, {
          onDownloadProgress: (status) => {
            phase = 'downloading_model';
            downloadProgress = status;
            broadcastPluginStatus();
          },
          onDownloadComplete: () => {
            phase = 'loading_model';
            downloadProgress = null;
            broadcastPluginStatus();
          },
        });

        llmRunner = getBuiltinLlmRunner();
        if (!llmRunner) {
          throw new Error('Built-in LLM is unavailable');
        }
        phase = 'running';
        downloadProgress = null;
        broadcastPluginStatus();
      }

      return llmRunner(input);
    };

    const sdk = createPluginSdk(db, config.notesPath, plugin.id, runId, lazyLlmRunner);
    const summary = await plugin.run({
      runId,
      triggerType,
      config: stored.config,
      sdk,
      signal: abortController?.signal ?? new AbortController().signal,
    });

    const items = listRunItems(db, runId);
    const summaryJson = JSON.stringify({
      ...summary,
      items: items.length,
      applyMode,
    });

    if (items.length === 0) {
      updateRun(db, runId, {
        status: 'succeeded',
        finishedAt: Date.now(),
        summaryJson,
        errorMessage: null,
      });
    } else if (stored.autoApply) {
      db.prepare(`
        UPDATE plugin_run_items
        SET status = 'approved', updated_at = ?
        WHERE run_id = ? AND status = 'suggested'
      `).run(Date.now(), runId);

      const applyResult = await applyApprovedItemsInternal(db, config, plugin, runId);
      updateRun(db, runId, {
        status: applyResult.failedCount > 0 ? 'failed' : 'succeeded',
        finishedAt: Date.now(),
        summaryJson: JSON.stringify({
          ...summary,
          items: items.length,
          applyMode,
          appliedCount: applyResult.appliedCount,
          failedCount: applyResult.failedCount,
        }),
        errorMessage: applyResult.failedCount > 0 ? 'One or more plugin changes failed to apply' : null,
      });
      applyNoteMutationEffects(db, {
        changedUuids: applyResult.changedUuids,
        deletedUuids: applyResult.deletedUuids,
        notifyClients: true,
        incrementVersion: true,
        searchEnabled: config.searchEnabled,
      });
    } else {
      updateRun(db, runId, {
        status: 'awaiting_approval',
        summaryJson,
        errorMessage: null,
      });
    }

    updatePluginRow(db, plugin.id, {
      lastRunAt: Date.now(),
      nextRunAt: stored.enabled ? nextScheduledAt({
        kind: stored.scheduleKind,
        time: stored.scheduleTime,
        day: stored.scheduleDay,
      }) : null,
    });
    lastError = null;
    return runId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateRun(db, runId, {
      status: 'failed',
      finishedAt: Date.now(),
      errorMessage: message,
    });
    lastError = message;
    throw err;
  } finally {
    await unloadBuiltinLlm().catch(() => {});
  }
}

async function runPluginInBackground(pluginId: string, triggerType: PluginTriggerType): Promise<string> {
  const config = currentConfig ?? loadConfig();
  const db = getDb();
  await ensureLocalPluginsLoaded(db, config);
  const plugin = getPlugin(pluginId);
  if (!plugin) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }
  if (running) {
    throw new Error('Plugin job already running');
  }
  if (!tryAcquire('plugins')) {
    throw new Error(`Cannot run plugin: ${holder()} job is in progress`);
  }

  ensurePluginRows(db);
  abortController = new AbortController();
  running = true;
  const runId = createRunRow(db, plugin.id, triggerType, getPluginStoredConfig(db, plugin).autoApply ? 'auto_apply' : 'preview');

  void executePluginRun(db, config, plugin, triggerType, { existingRunId: runId })
    .catch((err) => {
      log.error(`plugins: run failed for "${pluginId}": ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      running = false;
      phase = 'idle';
      downloadProgress = null;
      abortController = null;
      release('plugins');
      broadcastPluginStatus();
    });

  return runId;
}

async function runAllPluginsInBackground(plugins: BuiltinPlugin[]): Promise<RunAllBatchState> {
  const config = currentConfig ?? loadConfig();
  const db = getDb();
  if (running) {
    throw new Error('Plugin job already running');
  }
  if (!tryAcquire('plugins')) {
    throw new Error(`Cannot run plugin: ${holder()} job is in progress`);
  }

  abortController = new AbortController();
  running = true;
  phase = 'running';
  downloadProgress = null;
  runAllBatch = createRunAllBatch(plugins);
  broadcastPluginStatus();

  const batch = runAllBatch;
  void (async () => {
    try {
      for (const item of batch.items) {
        const plugin = getPlugin(item.pluginId);
        if (!plugin) {
          item.status = 'failed';
          item.errorMessage = `Unknown plugin: ${item.pluginId}`;
          item.finishedAt = Date.now();
          continue;
        }

        item.status = 'running';
        item.startedAt = Date.now();
        item.errorMessage = null;
        batch.currentPluginId = plugin.id;
        broadcastPluginStatus();

        const applyMode = getPluginStoredConfig(db, plugin).autoApply ? 'auto_apply' : 'preview';
        const runId = createRunRow(db, plugin.id, 'manual', applyMode);
        item.runId = runId;

        try {
          await executePluginRun(db, config, plugin, 'manual', { existingRunId: runId });
          finalizeBatchItemFromRun(item, getRunRow(db, runId));
        } catch (err) {
          const latestRun = getRunRow(db, runId);
          finalizeBatchItemFromRun(item, latestRun);
          if (!item.errorMessage) {
            item.errorMessage = err instanceof Error ? err.message : String(err);
          }
          log.error(`plugins: run-all item failed for "${plugin.id}": ${item.errorMessage}`);
        } finally {
          batch.currentPluginId = null;
          broadcastPluginStatus();
        }
      }
    } finally {
      batch.status = 'completed';
      batch.finishedAt = Date.now();
      batch.currentPluginId = null;
      running = false;
      phase = 'idle';
      downloadProgress = null;
      abortController = null;
      release('plugins');
      broadcastPluginStatus();
    }
  })();

  return cloneRunAllBatch(batch) as RunAllBatchState;
}

async function tick(): Promise<void> {
  if (running || !currentConfig) return;

  const config = currentConfig;
  const inWindow = isWithinIdleWindow(config.indexIdleStart, config.indexIdleEnd);
  const idleMs = Date.now() - lastActivity;
  const idleThresholdMs = 3 * 60 * 60 * 1000;
  if (!inWindow && idleMs < idleThresholdMs) return;

  const db = getDb();
  await ensureLocalPluginsLoaded(db, config);
  ensurePluginRows(db);

  const due = listPlugins().find((plugin) => {
    const stored = getPluginStoredConfig(db, plugin);
    return stored.enabled && stored.nextRunAt !== null && stored.nextRunAt <= Date.now();
  });
  if (!due) return;

  await runPluginInBackground(due.id, 'scheduled');
}

export function recordPluginActivity(): void {
  lastActivity = Date.now();
}

export function getPluginSchedulerState(): {
  phase: PluginSchedulerPhase;
  running: boolean;
  downloadProgress: { totalSize: number; downloadedSize: number } | null;
  lastError: string | null;
} {
  return {
    phase,
    running,
    downloadProgress: phase === 'downloading_model' ? downloadProgress : null,
    lastError,
  };
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const db = getDb();
  const config = currentConfig ?? loadConfig();
  await ensureLocalPluginsLoaded(db, config);
  ensurePluginRows(db);
  updatePluginRow(db, pluginId, { enabled });
}

export async function updatePluginConfig(pluginId: string, patch: {
  scheduleKind?: PluginScheduleConfig['kind'];
  scheduleTime?: string | null;
  scheduleDay?: number | null;
  autoApply?: boolean;
  config?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const config = currentConfig ?? loadConfig();
  await ensureLocalPluginsLoaded(db, config);
  ensurePluginRows(db);
  const plugin = getPlugin(pluginId);
  if (!plugin) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }
  const stored = getPluginStoredConfig(db, plugin);
  const nextConfig = patch.config ? { ...stored.config, ...patch.config } : stored.config;
  updatePluginRow(db, pluginId, {
    scheduleKind: patch.scheduleKind,
    scheduleTime: patch.scheduleTime,
    scheduleDay: patch.scheduleDay,
    autoApply: patch.autoApply,
    configJson: JSON.stringify(nextConfig),
  });
}

export async function triggerPluginNow(pluginId: string): Promise<{ runId: string }> {
  const runId = await runPluginInBackground(pluginId, 'manual');
  return { runId };
}

export async function triggerAllPluginsNow(): Promise<{
  batchId: string;
  queuedCount: number;
  batch: Record<string, unknown>;
}> {
  const config = currentConfig ?? loadConfig();
  const db = getDb();
  const enabledPlugins = await getEnabledPlugins(db, config);
  if (enabledPlugins.length === 0) {
    throw new Error('No enabled automations to run');
  }

  const batch = await runAllPluginsInBackground(enabledPlugins);
  return {
    batchId: batch.batchId,
    queuedCount: batch.items.length,
    batch: serializeRunAllBatch(batch),
  };
}

export function listPluginRuns(pluginId: string, limit = 10): Array<Record<string, unknown>> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM plugin_runs
    WHERE plugin_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(pluginId, limit) as PluginRunRow[];

  return rows.map((row) => {
    const itemCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'suggested' THEN 1 ELSE 0 END) AS suggested_count,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
        SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM plugin_run_items
      WHERE run_id = ?
    `).get(row.run_id) as {
      suggested_count: number | null;
      approved_count: number | null;
      rejected_count: number | null;
      applied_count: number | null;
      failed_count: number | null;
    };

    return {
      run_id: row.run_id,
      plugin_id: row.plugin_id,
      trigger_type: row.trigger_type,
      apply_mode: row.apply_mode,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      error_message: row.error_message,
      summary: parseRunSummary(row.summary_json),
      item_counts: {
        suggested: itemCounts.suggested_count ?? 0,
        approved: itemCounts.approved_count ?? 0,
        rejected: itemCounts.rejected_count ?? 0,
        applied: itemCounts.applied_count ?? 0,
        failed: itemCounts.failed_count ?? 0,
      },
    };
  });
}

export function getPluginRunDetail(runId: string): Record<string, unknown> {
  const db = getDb();
  const run = getRunRow(db, runId);
  const items = listRunItems(db, runId).map((item) => ({
    id: item.id,
    entity_type: item.entity_type,
    entity_id: item.entity_id,
    change_type: item.change_type,
    before: parseJsonObject(item.before_json),
    after: parseJsonObject(item.after_json),
    preview: parseJsonObject(item.preview_json),
    reason: item.reason,
    confidence: item.confidence,
    status: item.status,
    failure_message: item.failure_message,
    created_at: item.created_at,
    updated_at: item.updated_at,
    applied_at: item.applied_at,
  }));
  const logs = db.prepare(`
    SELECT timestamp, level, message, context_json
    FROM plugin_run_logs
    WHERE run_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(runId) as Array<{ timestamp: number; level: string; message: string; context_json: string | null }>;

  return {
    run: {
      run_id: run.run_id,
      plugin_id: run.plugin_id,
      trigger_type: run.trigger_type,
      apply_mode: run.apply_mode,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      error_message: run.error_message,
      summary: parseRunSummary(run.summary_json),
    },
    items,
    logs: logs.map((entry) => ({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      context: entry.context_json ? parseJsonObject(entry.context_json) : null,
    })),
  };
}

function updateRunItemStatus(runId: string, itemId: number, status: 'approved' | 'rejected'): void {
  const db = getDb();
  const item = db.prepare(`
    SELECT id, status
    FROM plugin_run_items
    WHERE run_id = ? AND id = ?
  `).get(runId, itemId) as { id: number; status: string } | undefined;
  if (!item) {
    throw new Error(`Unknown run item: ${itemId}`);
  }
  if (item.status !== 'suggested' && !(status === 'approved' && item.status === 'approved') && !(status === 'rejected' && item.status === 'rejected')) {
    throw new Error(`Run item ${itemId} is not pending approval`);
  }

  db.prepare(`
    UPDATE plugin_run_items
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).run(status, Date.now(), itemId);
  refreshRunTerminalStatus(db, runId);
}

export function approveRunItem(runId: string, itemId: number): void {
  updateRunItemStatus(runId, itemId, 'approved');
}

export function rejectRunItem(runId: string, itemId: number): void {
  updateRunItemStatus(runId, itemId, 'rejected');
}

export function approveAllRunItems(runId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE plugin_run_items
    SET status = 'approved', updated_at = ?
    WHERE run_id = ? AND status = 'suggested'
  `).run(Date.now(), runId);
  refreshRunTerminalStatus(db, runId);
}

export function rejectAllRunItems(runId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE plugin_run_items
    SET status = 'rejected', updated_at = ?
    WHERE run_id = ? AND status IN ('suggested', 'approved')
  `).run(Date.now(), runId);
  refreshRunTerminalStatus(db, runId);
}

export async function applyApprovedRunItems(runId: string): Promise<void> {
  const config = currentConfig ?? loadConfig();
  const db = getDb();
  await ensureLocalPluginsLoaded(db, config);
  const run = getRunRow(db, runId);
  const plugin = getPlugin(run.plugin_id);
  if (!plugin) {
    throw new Error(`Unknown plugin: ${run.plugin_id}`);
  }
  if (!tryAcquire('plugins')) {
    throw new Error(`Cannot apply approved changes: ${holder()} job is in progress`);
  }

  running = true;
  abortController = new AbortController();
  phase = 'running';
  broadcastPluginStatus();

  try {
    updateRun(db, runId, { status: 'running', errorMessage: null });
    const result = await applyApprovedItemsInternal(db, config, plugin, runId);
    const status = refreshRunTerminalStatus(db, runId);
    if (status === 'succeeded') {
      const latest = getRunRow(db, runId);
      const summary = parseRunSummary(latest.summary_json) ?? {};
      updateRun(db, runId, {
        summaryJson: JSON.stringify({
          ...summary,
          appliedCount: result.appliedCount,
          failedCount: result.failedCount,
        }),
      });
    }
    applyNoteMutationEffects(db, {
      changedUuids: result.changedUuids,
      deletedUuids: result.deletedUuids,
      notifyClients: true,
      incrementVersion: true,
      searchEnabled: config.searchEnabled,
    });
  } finally {
    running = false;
    abortController = null;
    phase = 'idle';
    release('plugins');
    broadcastPluginStatus();
  }
}

export async function getPluginsStatus(): Promise<{
  plugins: Array<Record<string, unknown>>;
  model: { id: string; loaded: boolean; download_progress: { totalSize: number; downloadedSize: number } | null };
  scheduler: { phase: PluginSchedulerPhase; running: boolean; last_error: string | null };
  run_all_batch: Record<string, unknown> | null;
}> {
  const config = currentConfig ?? loadConfig();
  const db = getDb();
  await ensureLocalPluginsLoaded(db, config);
  ensurePluginRows(db);

  const plugins = listPluginRegistrations().map((entry) => {
    const plugin = entry.plugin;
    const stored = getPluginStoredConfig(db, plugin);
    const lastRun = db.prepare(`
      SELECT *
      FROM plugin_runs
      WHERE plugin_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(plugin.id) as PluginRunRow | undefined;
    const pendingApproval = db.prepare(`
      SELECT COUNT(*) AS count
      FROM plugin_run_items i
      JOIN plugin_runs r ON r.run_id = i.run_id
      WHERE r.plugin_id = ?
        AND i.status IN ('suggested', 'approved')
        AND r.status = 'awaiting_approval'
    `).get(plugin.id) as { count: number };

    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      source_kind: entry.sourceKind,
      source_label: entry.sourceLabel,
      source_path: entry.sourcePath,
      load_status: entry.loadStatus,
      load_error: entry.loadError,
      can_edit: entry.canEdit,
      can_delete: entry.canDelete,
      enabled: stored.enabled,
      auto_apply: stored.autoApply,
      schedule: {
        kind: stored.scheduleKind,
        time: stored.scheduleTime,
        day: stored.scheduleDay,
      },
      config_schema: plugin.configSchema,
      config: stored.config,
      next_run_at: stored.nextRunAt,
      last_run_at: stored.lastRunAt,
      pending_approval_count: pendingApproval.count,
      last_run: lastRun ? {
        run_id: lastRun.run_id,
        status: lastRun.status,
        trigger_type: lastRun.trigger_type,
        apply_mode: lastRun.apply_mode,
        started_at: lastRun.started_at,
        finished_at: lastRun.finished_at,
        error_message: lastRun.error_message,
        summary: parseRunSummary(lastRun.summary_json),
      } : null,
      recent_runs: listPluginRuns(plugin.id, 5),
    };
  });

  const modelInfo = getBuiltinLlmInfo();
  return {
    plugins,
    model: {
      id: modelInfo.id,
      loaded: modelInfo.loaded,
      download_progress: phase === 'downloading_model' ? downloadProgress : null,
    },
    scheduler: {
      phase,
      running,
      last_error: lastError,
    },
    run_all_batch: serializeRunAllBatch(runAllBatch),
  };
}

export function startPluginScheduler(config: Config): void {
  currentConfig = config;
  void ensureLocalPluginsLoaded(getDb(), config)
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log.error(`plugins: failed to load local plugins: ${lastError}`);
    })
    .finally(() => {
      ensurePluginRows(getDb());
      broadcastPluginStatus();
    });
  schedulerInterval = setInterval(() => {
    tick().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      log.error(`plugins: scheduler error: ${lastError}`);
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
  phase = 'idle';
  currentConfig = null;
  abortController = null;
  downloadProgress = null;
  release('plugins');
}
