import type { Config } from '../config.js';
import { getDb } from '../db/index.js';
import { getAllTransforms } from './registry.js';
import { runTransformJob } from './runner.js';
import { loadGenerationModel, getGenerateFn, unloadGenerationModel, getGenerationModelInfo } from './generationModel.js';
import { isWithinIdleWindow } from '../search/scheduler.js';
import { tryAcquire, release, holder } from '../schedulerLock.js';
import { broadcastSyncAvailable, broadcastTransformStatus } from '../events.js';
import { log } from '../logger.js';

export type TransformSchedulerPhase =
  | 'idle'
  | 'downloading_model'
  | 'loading_model'
  | 'running'
  | 'disabled';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let running = false;
let currentConfig: Config | null = null;
let phase: TransformSchedulerPhase = 'idle';
let downloadProgress: { totalSize: number; downloadedSize: number } | null = null;
let abortController: AbortController | null = null;
let lastActivity = Date.now();
let lastError: string | null = null;

/** Record transform-specific activity for idle tracking. */
export function recordTransformActivity(): void {
  lastActivity = Date.now();
}

export function getTransformSchedulerState(): {
  phase: TransformSchedulerPhase;
  running: boolean;
  downloadProgress: { totalSize: number; downloadedSize: number } | null;
} {
  return {
    phase,
    running,
    downloadProgress: phase === 'downloading_model' ? downloadProgress : null,
  };
}

/**
 * Check whether a specific transform is enabled in the DB.
 */
function isTransformEnabled(transformId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT value FROM transform_config WHERE transform_id = ? AND key = 'enabled'",
  ).get(transformId) as { value: string } | undefined;
  return row?.value === '1';
}

/**
 * Get merged config for a transform: DB values over schema defaults.
 */
function getTransformConfig(transformId: string, schema: { key: string; default: unknown }[]): Record<string, unknown> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT key, value FROM transform_config WHERE transform_id = ?',
  ).all(transformId) as { key: string; value: string }[];

  const dbConfig: Record<string, string> = {};
  for (const row of rows) {
    dbConfig[row.key] = row.value;
  }

  const config: Record<string, unknown> = {};
  for (const field of schema) {
    if (field.key === 'enabled') continue;
    if (field.key in dbConfig) {
      const raw = dbConfig[field.key];
      if (typeof field.default === 'number') {
        config[field.key] = Number(raw);
      } else if (typeof field.default === 'boolean') {
        config[field.key] = raw === '1' || raw === 'true';
      } else {
        config[field.key] = raw;
      }
    } else {
      config[field.key] = field.default;
    }
  }
  return config;
}

async function tick(): Promise<void> {
  if (running || !currentConfig) return;

  const config = currentConfig;

  // Check idle window or idle threshold
  const inWindow = isWithinIdleWindow(config.indexIdleStart, config.indexIdleEnd);
  const idleMs = Date.now() - lastActivity;
  const idleThresholdMs = 3 * 60 * 60 * 1000; // 3 hours

  if (!inWindow && idleMs < idleThresholdMs) return;

  // Check if any enabled transform has pending work
  const db = getDb();
  const transforms = getAllTransforms();
  const enabledWithWork: { transform: typeof transforms[0]; pendingCount: number }[] = [];

  for (const t of transforms) {
    if (!isTransformEnabled(t.id)) continue;
    const pending = t.getPendingNotes(db);
    if (pending.length > 0) {
      enabledWithWork.push({ transform: t, pendingCount: pending.length });
    }
  }

  if (enabledWithWork.length === 0) return;

  if (!tryAcquire('transforms')) {
    return; // another scheduler holds the lock
  }

  log.info(`transforms: scheduler triggered (inWindow=${inWindow} idle=${Math.round(idleMs / 60000)}min transforms=${enabledWithWork.length})`);

  running = true;
  abortController = new AbortController();
  let hadRenames = false;

  try {
    // Load generation model
    phase = 'loading_model';
    downloadProgress = null;
    broadcastTransformStatus();

    await loadGenerationModel(config.modelsPath, {
      onDownloadProgress: (status) => { phase = 'downloading_model'; downloadProgress = status; broadcastTransformStatus(); },
      onDownloadComplete: () => { phase = 'loading_model'; downloadProgress = null; broadcastTransformStatus(); },
    });

    phase = 'running';
    broadcastTransformStatus();

    const generate = getGenerateFn();
    if (!generate) {
      log.error('transforms: generation model loaded but generate function unavailable');
      return;
    }

    // Run each enabled transform
    for (const { transform } of enabledWithWork) {
      if (abortController.signal.aborted) break;

      const transformConfig = getTransformConfig(transform.id, transform.configSchema);
      const result = await runTransformJob(
        db, transform, config.notesPath, transformConfig,
        generate, config.indexBatchSize, abortController.signal,
      );

      if (result.results.some((r) => r.action === 'rename')) {
        hadRenames = true;
      }
    }

    // Unload model to free memory
    await unloadGenerationModel();

    // Notify clients about renames
    if (hadRenames) {
      broadcastSyncAvailable();
    }
    lastError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`transforms: scheduler error: ${message}`);
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

/**
 * Enable or disable a specific transform.
 */
export function setTransformEnabled(transformId: string, enabled: boolean): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO transform_config (transform_id, key, value, updated_at)
    VALUES (?, 'enabled', ?, ?)
    ON CONFLICT(transform_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(transformId, enabled ? '1' : '0', now);
}

/**
 * Update a transform's config value.
 */
export function setTransformConfigValue(transformId: string, key: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO transform_config (transform_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(transform_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(transformId, key, value, now);
}

/**
 * Trigger a specific transform to run immediately, bypassing the idle window.
 */
export function triggerTransformNow(transformId: string): void {
  if (!currentConfig) {
    throw new Error('Transform scheduler not initialized');
  }
  if (running) {
    throw new Error('Transform job already running');
  }
  if (!tryAcquire('transforms')) {
    throw new Error(`Cannot run transform: ${holder()} job is in progress`);
  }

  const config = currentConfig;
  running = true;
  abortController = new AbortController();

  void (async () => {
    let hadRenames = false;
    try {
      const db = getDb();
      const transforms = getAllTransforms();
      const transform = transforms.find((t) => t.id === transformId);
      if (!transform) throw new Error(`Unknown transform: ${transformId}`);

      phase = 'loading_model';
      downloadProgress = null;
      broadcastTransformStatus();

      await loadGenerationModel(config.modelsPath, {
        onDownloadProgress: (status) => { phase = 'downloading_model'; downloadProgress = status; broadcastTransformStatus(); },
        onDownloadComplete: () => { phase = 'loading_model'; downloadProgress = null; broadcastTransformStatus(); },
      });

      phase = 'running';
      broadcastTransformStatus();

      const generate = getGenerateFn();
      if (!generate) throw new Error('Generation model not available');

      const transformConfig = getTransformConfig(transform.id, transform.configSchema);
      const result = await runTransformJob(
        db, transform, config.notesPath, transformConfig,
        generate, config.indexBatchSize, abortController!.signal,
        { force: true },
      );

      if (result.results.some((r) => r.action === 'rename')) {
        hadRenames = true;
      }

      await unloadGenerationModel();

      if (hadRenames) {
        broadcastSyncAvailable();
      }
      lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`transforms: manual trigger failed for "${transformId}": ${message}`);
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

/**
 * Get the pending count for a specific transform.
 */
export function getPendingCount(transformId: string): number {
  const db = getDb();
  const transforms = getAllTransforms();
  const transform = transforms.find((t) => t.id === transformId);
  if (!transform) return 0;
  return transform.getPendingNotes(db).length;
}

/**
 * Get full status for all transforms (for API/dashboard).
 */
export function getTransformsStatus(): {
  transforms: {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    configSchema: typeof transforms[0]['configSchema'];
    config: Record<string, unknown>;
    pending_count: number;
    last_run: { status: string; finished_at: number | null; notes_processed: number; error_message: string | null } | null;
  }[];
  model: { id: string; loaded: boolean; download_progress: { totalSize: number; downloadedSize: number } | null };
  scheduler: { phase: TransformSchedulerPhase; running: boolean; last_error: string | null };
} {
  const db = getDb();
  const transforms = getAllTransforms();
  const modelInfo = getGenerationModelInfo();

  const transformStatuses = transforms.map((t) => {
    const enabled = isTransformEnabled(t.id);
    const config = getTransformConfig(t.id, t.configSchema);

    let pendingCount = 0;
    try {
      pendingCount = t.getPendingNotes(db).length;
    } catch { /* tables may not exist yet */ }

    const lastRun = db.prepare(`
      SELECT status, finished_at, notes_processed, error_message
      FROM transform_jobs WHERE transform_id = ? AND status IN ('completed', 'failed')
      ORDER BY finished_at DESC LIMIT 1
    `).get(t.id) as { status: string; finished_at: number | null; notes_processed: number; error_message: string | null } | undefined;

    return {
      id: t.id,
      name: t.name,
      description: t.description,
      enabled,
      configSchema: t.configSchema,
      config,
      pending_count: pendingCount,
      last_run: lastRun ? {
        status: lastRun.status,
        finished_at: lastRun.finished_at,
        notes_processed: lastRun.notes_processed,
        error_message: lastRun.error_message,
      } : null,
    };
  });

  return {
    transforms: transformStatuses,
    model: {
      id: modelInfo.id,
      loaded: modelInfo.loaded,
      download_progress: phase === 'downloading_model' ? downloadProgress : null,
    },
    scheduler: { phase, running, last_error: lastError },
  };
}

/**
 * Start the transform scheduler. Checks every 60s if transforms should run.
 */
export function startTransformScheduler(config: Config): void {
  currentConfig = config;
  schedulerInterval = setInterval(() => {
    tick().catch((err) => {
      log.error(`transforms: scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 60_000);
  schedulerInterval.unref();
  log.info('transforms: scheduler started');
}

/**
 * Stop the transform scheduler.
 */
export function stopTransformScheduler(): void {
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
