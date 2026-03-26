import path from 'node:path';
import type { Config } from '../config.js';
import { getDb } from '../db/index.js';
import { getDirtyUuids } from './dirtyTracker.js';
import { runIndexJob } from './jobRunner.js';
import { log } from '../logger.js';
import { tryAcquire, release, holder } from '../schedulerLock.js';

export type SchedulerPhase =
  | 'idle'
  | 'downloading_model'
  | 'loading_model'
  | 'indexing'
  | 'building_artifacts'
  | 'disabled';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastActivity = Date.now();
let running = false;
let currentConfig: Config | null = null;
let disabledByUser = false;
let phase: SchedulerPhase = 'idle';
let downloadProgress: { totalSize: number; downloadedSize: number } | null = null;
let abortController: AbortController | null = null;
let runningJobPromise: Promise<void> | null = null;
let activeJobToken = 0;

function isDisabled(): boolean {
  return disabledByUser;
}

function setEnhancedSearchEnabledConfig(enabled: boolean): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO search_config (key, value, updated_at) VALUES ('enhanced_search_enabled', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(enabled ? '1' : '0', now);
}

function getEnhancedSearchEnabledConfig(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT value FROM search_config WHERE key = 'enhanced_search_enabled'")
    .get() as { value: string } | undefined;
  if (!row) return true;
  return row.value !== '0';
}

/**
 * Get the current scheduler state for dashboard display.
 */
export function getSchedulerState(): {
  phase: SchedulerPhase;
  modelReady: boolean;
  idleWindow: { start: string; end: string; active: boolean } | null;
  downloadProgress: { totalSize: number; downloadedSize: number } | null;
  userEnabled: boolean;
  disabledReason: 'user' | null;
} {
  if (!currentConfig) {
    return {
      phase: 'idle',
      modelReady: false,
      idleWindow: null,
      downloadProgress: null,
      userEnabled: true,
      disabledReason: null,
    };
  }
  return {
    phase: isDisabled() ? 'disabled' : phase,
    modelReady: jobProcessor !== null,
    idleWindow: {
      start: currentConfig.indexIdleStart,
      end: currentConfig.indexIdleEnd,
      active: isWithinIdleWindow(currentConfig.indexIdleStart, currentConfig.indexIdleEnd),
    },
    downloadProgress: phase === 'downloading_model' ? downloadProgress : null,
    userEnabled: !disabledByUser,
    disabledReason: disabledByUser ? 'user' : null,
  };
}

// Track job processor — lazily initialized on first indexing trigger
let jobProcessor: ((db: import('better-sqlite3').Database, uuids: string[]) => Promise<void>) | null = null;
let ensureProcessorPromise: Promise<boolean> | null = null;

/**
 * Parse "HH:MM" into { hours, minutes }.
 */
function parseTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(':').map(Number);
  return { hours: h, minutes: m };
}

/**
 * Check if the current local time is within the idle window [start, end).
 * Handles windows that span midnight (e.g. 23:00 to 06:00).
 */
export function isWithinIdleWindow(start: string, end: string, now?: Date): boolean {
  const d = now ?? new Date();
  const currentMinutes = d.getHours() * 60 + d.getMinutes();
  const s = parseTime(start);
  const e = parseTime(end);
  const startMinutes = s.hours * 60 + s.minutes;
  const endMinutes = e.hours * 60 + e.minutes;

  if (startMinutes <= endMinutes) {
    // Same day window: e.g. 02:00-06:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Spans midnight: e.g. 23:00-06:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

/**
 * Record activity (called on sync, etc.) to track idle time.
 */
export function recordActivity(): void {
  lastActivity = Date.now();
}

async function canUseEmbeddingModelNow(): Promise<boolean> {
  if (holder() === 'plugins') {
    return false;
  }
  const { isBuiltinLlmLoaded } = await import('../plugins/llm.js');
  return !isBuiltinLlmLoaded();
}

/**
 * Ensure the embedding model is loaded and ready for queries.
 * Can be called from the embed-query endpoint to load on-demand.
 */
export async function ensureModelLoaded(): Promise<boolean> {
  if (!currentConfig) return false;
  if (!(await canUseEmbeddingModelNow())) return false;
  return ensureProcessor(currentConfig);
}

/**
 * Lazily initialize the embedding pipeline.
 * Downloads model (if needed), loads it, creates processor.
 * Returns true if the processor is ready.
 */
async function ensureProcessor(config: Config): Promise<boolean> {
  if (jobProcessor) return true;
  if (isDisabled()) return false;
  if (ensureProcessorPromise) return ensureProcessorPromise;

  ensureProcessorPromise = ensureProcessorImpl(config).finally(() => {
    // Query-triggered lazy loads (not background indexing jobs) should
    // return the scheduler phase to idle once model init settles.
    if (
      !running
      && !isDisabled()
      && (phase === 'downloading_model' || phase === 'loading_model')
    ) {
      phase = 'idle';
    }
    ensureProcessorPromise = null;
  });

  return ensureProcessorPromise;
}

async function ensureProcessorImpl(config: Config): Promise<boolean> {
  if (jobProcessor) return true;
  if (isDisabled()) return false;

  const db = getDb();
  const { getModelDef, DEFAULT_MODEL_ID } = await import('./modelRegistry.js');

  // Check if a model was already selected from a previous run
  const existingModel = (db.prepare("SELECT value FROM search_config WHERE key = 'embedding_model'")
    .get() as { value: string } | undefined)?.value;

  const modelId = (existingModel && getModelDef(existingModel))
    ? existingModel
    : DEFAULT_MODEL_ID;

  if (existingModel && existingModel !== modelId) {
    log.info(`search: migrating from ${existingModel} to ${modelId}`);
  }

  const modelDef = getModelDef(modelId);
  if (!modelDef) {
    log.error(`search: model "${modelId}" not found in registry`);
    return false;
  }

  // Init vector DB with the model's dims
  const { initVectorDb } = await import('../db/vectorDb.js');
  await initVectorDb(db, modelDef.dims);

  // Download model (if needed), then load into memory
  phase = 'loading_model';
  downloadProgress = null;
  const { loadEmbeddingModel } = await import('./modelManager.js');
  const model = await loadEmbeddingModel(modelDef, config.modelsPath, {
    onDownloadProgress: (status) => { phase = 'downloading_model'; downloadProgress = status; },
    onDownloadComplete: () => { phase = 'loading_model'; downloadProgress = null; },
  });

  // Store model info in search_config for status/capabilities
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  upsert.run('embedding_model', modelDef.id, now);
  upsert.run('embedding_dims', String(modelDef.dims), now);
  if (modelDef.queryPrefix) {
    upsert.run('query_prefix', modelDef.queryPrefix, now);
  }

  // Detect model/quantization change and force re-index
  const storedUri = (db.prepare("SELECT value FROM search_config WHERE key = 'model_uri'")
    .get() as { value: string } | undefined)?.value;
  if (storedUri && storedUri !== modelDef.hfUri) {
    log.info(`search: model changed from "${storedUri}" to "${modelDef.hfUri}", clearing index for re-embedding`);
    db.prepare('DELETE FROM search_index_state').run();
  }
  upsert.run('model_uri', modelDef.hfUri, now);

  // Create processor
  const { createEmbeddingProcessor } = await import('./embeddingIndexer.js');
  jobProcessor = createEmbeddingProcessor(model, config.notesPath);

  log.info('search: embedding processor initialized');
  return true;
}

function startTrackedIndexJob(config: Config, errorPrefix: string): Promise<void> {
  const jobToken = ++activeJobToken;
  running = true;
  phase = 'indexing';
  abortController = new AbortController();

  const promise = runIndexInBackground(config, abortController.signal).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${errorPrefix}: ${message}`);
  }).finally(() => {
    // Ignore stale completions from jobs that were superseded by a newer run.
    if (activeJobToken !== jobToken) return;
    running = false;
    phase = 'idle';
    abortController = null;
    runningJobPromise = null;
    release('search');
  });

  runningJobPromise = promise;
  return promise;
}

/**
 * Trigger an indexing job immediately, bypassing the idle window.
 * Validates synchronously, then runs the job in the background.
 */
export function triggerIndexNow(): void {
  if (!currentConfig) {
    throw new Error('Search scheduler not initialized');
  }
  if (running) {
    throw new Error('Index job already running');
  }
  if (!tryAcquire('search')) {
    throw new Error(`Cannot reindex: ${holder()} job is in progress`);
  }

  const config = currentConfig;
  void startTrackedIndexJob(config, 'search: manual reindex failed');
}

async function runIndexInBackground(config: Config, signal?: AbortSignal): Promise<void> {
  const ready = await ensureProcessor(config);
  if (!ready || !jobProcessor) {
    throw new Error('Embedding model not available');
  }
  if (signal?.aborted) return;
  const db = getDb();
  phase = 'indexing';
  await runIndexJob(db, 2, config.indexBatchSize, jobProcessor, signal);

  // Build artifacts and notify clients
  phase = 'building_artifacts';
  const { buildArtifacts } = await import('./artifactBuilder.js');
  const artifactDir = path.join(path.dirname(config.databasePath), 'search-artifacts');
  await buildArtifacts(db, artifactDir);
  const { broadcastSupersearchReady } = await import('../events.js');
  broadcastSupersearchReady();
}

async function tick(): Promise<void> {
  if (running || !currentConfig || isDisabled()) return;

  const config = currentConfig;
  const inWindow = isWithinIdleWindow(config.indexIdleStart, config.indexIdleEnd);
  const idleMs = Date.now() - lastActivity;
  const idleThresholdMs = 3 * 60 * 60 * 1000; // 3 hours

  if (!inWindow && idleMs < idleThresholdMs) return;

  const db = getDb();
  const dirtyCount = getDirtyUuids(db, 2).length;
  if (dirtyCount === 0) return;

  if (!tryAcquire('search')) {
    log.info(`search: skipping tick, scheduler lock held by ${holder()}`);
    return;
  }

  log.info(`search: scheduler triggered (inWindow=${inWindow} idle=${Math.round(idleMs / 60000)}min dirty=${dirtyCount})`);

  await startTrackedIndexJob(config, 'search: scheduler tick failed');
}

/**
 * Start the search scheduler. Checks every 60s if indexing should run.
 */
export function startSearchScheduler(config: Config): void {
  currentConfig = config;
  disabledByUser = !getEnhancedSearchEnabledConfig();
  schedulerInterval = setInterval(() => {
    tick().catch((err) => {
      log.error(`search: scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 60_000);
  schedulerInterval.unref();
  log.info(`search: scheduler started (idle window ${config.indexIdleStart}-${config.indexIdleEnd})`);
}


/**
 * Stop the search scheduler and wait for any in-flight job to finish.
 */
export async function stopSearchScheduler(): Promise<void> {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  activeJobToken++;
  abortController?.abort();
  if (runningJobPromise) {
    try { await runningJobPromise; } catch { /* job may reject on abort — safe to ignore */ }
  }
  running = false;
  release('search');
  runningJobPromise = null;
  abortController = null;
  currentConfig = null;
  jobProcessor = null;
  ensureProcessorPromise = null;
  disabledByUser = false;
  downloadProgress = null;
}

// ── Sync-triggered indexing ──────────────────────────────

let lastSyncTriggerTime = 0;
const SYNC_TRIGGER_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Trigger indexing after sync mutates server state.
 * First invocation after server start runs immediately.
 * Subsequent invocations are throttled to at most once per 10 minutes.
 * Bypasses the idle window but respects the scheduler lock.
 */
export function triggerIndexAfterSync(): void {
  if (!currentConfig || running || isDisabled()) return;

  const now = Date.now();
  if (lastSyncTriggerTime > 0 && now - lastSyncTriggerTime < SYNC_TRIGGER_THROTTLE_MS) {
    return; // Throttled
  }

  const db = getDb();
  const dirtyCount = getDirtyUuids(db, 2).length;
  if (dirtyCount === 0) return;

  if (!tryAcquire('search')) {
    log.info(`search: sync trigger skipped, lock held by ${holder()}`);
    return;
  }

  lastSyncTriggerTime = now;
  log.info(`search: sync-triggered indexing (dirty=${dirtyCount})`);
  void startTrackedIndexJob(currentConfig, 'search: sync-triggered index failed');
}

export async function setEnhancedSearchEnabled(enabled: boolean): Promise<void> {
  if (!currentConfig) {
    throw new Error('Search scheduler not initialized');
  }

  disabledByUser = !enabled;
  setEnhancedSearchEnabledConfig(enabled);
  downloadProgress = null;

  if (!enabled) {
    if (running && abortController) {
      abortController.abort();
    }
    if (runningJobPromise) {
      await runningJobPromise;
    }
    if (ensureProcessorPromise) {
      try {
        await ensureProcessorPromise;
      } catch {
        // Ignore lazy init failures while disabling.
      }
    }

    const { unloadModel } = await import('./modelManager.js');
    await unloadModel();
    jobProcessor = null;
    phase = 'idle';
    return;
  }

}
