import path from 'node:path';
import type { Config } from '../config.js';
import { getDb } from '../db/index.js';
import { getDirtyUuids } from './dirtyTracker.js';
import { runIndexJob } from './jobRunner.js';
import { log } from '../logger.js';

export type SchedulerPhase =
  | 'idle'
  | 'benchmarking'
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
let disabledByHardware = false;
let phase: SchedulerPhase = 'idle';
let downloadProgress: { totalSize: number; downloadedSize: number } | null = null;
let abortController: AbortController | null = null;
let runningJobPromise: Promise<void> | null = null;
let activeJobToken = 0;
let modelChangeInProgress = false;

function isDisabled(): boolean {
  return disabledByUser || disabledByHardware;
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
  disabledReason: 'user' | 'hardware' | null;
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
    disabledReason: disabledByUser ? 'user' : disabledByHardware ? 'hardware' : null,
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

/**
 * Ensure the embedding model is loaded and ready for queries.
 * Can be called from the embed-query endpoint to load on-demand.
 */
export async function ensureModelLoaded(): Promise<boolean> {
  if (!currentConfig) return false;
  return ensureProcessor(currentConfig);
}

/**
 * Lazily initialize the embedding pipeline.
 * Runs benchmark (if needed), downloads model, loads it, creates processor.
 * Returns true if the processor is ready, false if hardware is too slow.
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
      && (phase === 'benchmarking' || phase === 'downloading_model' || phase === 'loading_model')
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
  const { getModelDef } = await import('./modelRegistry.js');

  let modelId: string | null = null;
  let modelFilePath: string | null = null;

  if (config.embeddingModel) {
    // User override — check if it's a registry ID or a file path
    const registryModel = getModelDef(config.embeddingModel);
    if (registryModel) {
      modelId = registryModel.id;
    } else {
      // Treat as a direct file path — can't use registry metadata
      modelFilePath = config.embeddingModel;
    }
  } else {
    // Check if a model was already selected from a previous run
    const existingModel = (db.prepare("SELECT value FROM search_config WHERE key = 'embedding_model'")
      .get() as { value: string } | undefined)?.value;
    if (existingModel && getModelDef(existingModel)) {
      modelId = existingModel;
      log.info(`search: using previously selected model ${modelId}`);
    } else {
      // First run — benchmark to select a model
      phase = 'benchmarking';
      const { runBenchmark } = await import('./benchmark.js');
      const result = await runBenchmark(db, config.modelsPath);
      if (!result.selectedModelId) {
        log.warn('search: hardware too slow for embeddings, disabling indexer');
        disabledByHardware = true;
        return false;
      }
      modelId = result.selectedModelId;
    }
  }

  // Resolve model def and load
  if (modelId) {
    const modelDef = getModelDef(modelId);
    if (!modelDef) {
      log.error(`search: model "${modelId}" not found in registry`);
      disabledByHardware = true;
      return false;
    }

    // Init vector DB with the model's dims
    const { initVectorDb } = await import('../db/vectorDb.js');
    await initVectorDb(db, modelDef.dims);

    // Download model (if needed), then load into memory
    phase = 'downloading_model';
    downloadProgress = null;
    const { loadEmbeddingModel } = await import('./modelManager.js');
    const model = await loadEmbeddingModel(modelDef, config.modelsPath, {
      onDownloadProgress: (status) => { downloadProgress = status; },
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

    // Create processor
    const { createEmbeddingProcessor } = await import('./embeddingIndexer.js');
    jobProcessor = createEmbeddingProcessor(model, config.notesPath);
  } else if (modelFilePath) {
    // Direct file path — user must know what they're doing
    // Use a fallback ModelDef with 384 dims (user can also set EMBEDDING_DIMS env later)
    log.warn(`search: using custom model path "${modelFilePath}" — assuming 384 dims`);

    const { initVectorDb } = await import('../db/vectorDb.js');
    const dims = 384;
    await initVectorDb(db, dims);

    // Build a synthetic ModelDef for the custom path
    const { loadEmbeddingModel } = await import('./modelManager.js');
    const customDef = {
      id: 'custom',
      hfUri: modelFilePath,
      nativeDims: dims,
      dims,
      sizeBytes: 0,
      queryPrefix: null,
      docPrefix: null,
    };
    const model = await loadEmbeddingModel(customDef, config.modelsPath);

    const { createEmbeddingProcessor } = await import('./embeddingIndexer.js');
    jobProcessor = createEmbeddingProcessor(model, config.notesPath);
  }

  log.info('search: embedding processor initialized');
  return true;
}

function startTrackedIndexJob(config: Config, errorPrefix: string): Promise<void> {
  const jobToken = ++activeJobToken;
  running = true;
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
  if (modelChangeInProgress) {
    throw new Error('Model change in progress');
  }
  if (running) {
    throw new Error('Index job already running');
  }

  const config = currentConfig;
  void startTrackedIndexJob(config, 'search: manual reindex failed');
}

async function runIndexInBackground(config: Config, signal?: AbortSignal): Promise<void> {
  const ready = await ensureProcessor(config);
  if (!ready || !jobProcessor) {
    throw new Error('Embedding model not available (hardware too slow or model missing)');
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
  if (running || !currentConfig || isDisabled() || modelChangeInProgress) return;

  const config = currentConfig;
  const inWindow = isWithinIdleWindow(config.indexIdleStart, config.indexIdleEnd);
  const idleMs = Date.now() - lastActivity;
  const idleThresholdMs = 3 * 60 * 60 * 1000; // 3 hours

  if (!inWindow && idleMs < idleThresholdMs) return;

  const db = getDb();
  const dirtyCount = getDirtyUuids(db, 2).length;
  if (dirtyCount === 0) return;

  log.info(`search: scheduler triggered (inWindow=${inWindow} idle=${Math.round(idleMs / 60000)}min dirty=${dirtyCount})`);

  await startTrackedIndexJob(config, 'search: scheduler tick failed');
}

/**
 * Start the search scheduler. Checks every 60s if indexing should run.
 */
export function startSearchScheduler(config: Config): void {
  currentConfig = config;
  disabledByUser = !getEnhancedSearchEnabledConfig();
  disabledByHardware = false;
  schedulerInterval = setInterval(() => {
    tick().catch((err) => {
      log.error(`search: scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 60_000);
  schedulerInterval.unref();
  log.info(`search: scheduler started (idle window ${config.indexIdleStart}-${config.indexIdleEnd})`);
}

/**
 * Change the embedding model. Cancels any running job, unloads the current model,
 * wipes the search index, and reinitializes with the new model.
 */
export async function changeModel(newModelId: string): Promise<void> {
  if (!currentConfig) {
    throw new Error('Search scheduler not initialized');
  }
  if (modelChangeInProgress) {
    throw new Error('Model change already in progress');
  }
  modelChangeInProgress = true;
  downloadProgress = null;

  try {
    const { getModelDef } = await import('./modelRegistry.js');
    const newModelDef = getModelDef(newModelId);
    if (!newModelDef) {
      throw new Error(`Unknown model: ${newModelId}`);
    }

    // Cancel any running job and wait for it to settle.
    if (running && abortController) {
      log.info('search: cancelling current job for model change...');
      abortController.abort();
    }
    if (runningJobPromise) {
      await runningJobPromise;
    }

    // Wait for any in-flight lazy model initialization to settle.
    if (ensureProcessorPromise) {
      try {
        await ensureProcessorPromise;
      } catch {
        // Ignore here; we're replacing the model anyway.
      }
    }

    const db = getDb();
    const { initVectorDb, resetVectorDb } = await import('../db/vectorDb.js');

    // Preflight: ensure vec0 extension is loaded in this process before any
    // destructive schema changes. Without this, dropping an existing vec0 table
    // can fail with "no such module: vec0" on a fresh server process.
    await initVectorDb(db, newModelDef.dims);

    // Unload current model from memory
    const { unloadModel } = await import('./modelManager.js');
    await unloadModel();
    jobProcessor = null;

    // Wipe and model-config update must be atomic to avoid partial state
    // if the process exits mid-model switch.
    const now = Date.now();
    const applyModelSwitch = db.transaction(() => {
      db.exec('DELETE FROM search_chunks');
      db.exec('DELETE FROM search_index_state');
      db.exec('DELETE FROM search_jobs');
      db.exec('DROP TABLE IF EXISTS search_vectors');

      const upsert = db.prepare(`
        INSERT INTO search_config (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      upsert.run('embedding_model', newModelDef.id, now);
      upsert.run('embedding_dims', String(newModelDef.dims), now);
      if (newModelDef.queryPrefix) {
        upsert.run('query_prefix', newModelDef.queryPrefix, now);
      } else {
        db.prepare("DELETE FROM search_config WHERE key = 'query_prefix'").run();
      }
      // Clear stale artifact references
      db.prepare("DELETE FROM search_config WHERE key IN ('artifact_version', 'artifact_hash')").run();
    });
    applyModelSwitch();

    // Reset vectorDb so it can be recreated with new dims.
    // Done after DROP TABLE succeeds in the transaction above.
    resetVectorDb();

    // Delete old artifact files
    const fs = await import('node:fs/promises');
    const artifactDir = path.join(path.dirname(currentConfig.databasePath), 'search-artifacts');
    try {
      const files = await fs.readdir(artifactDir);
      await Promise.all(files.map(async (file) => {
        try {
          await fs.unlink(path.join(artifactDir, file));
        } catch {
          // Best-effort cleanup
        }
      }));
    } catch {
      // Directory may not exist
    }

    // Clear env override so DB selection takes precedence
    currentConfig.embeddingModel = undefined;

    log.info(`search: model changed to "${newModelId}" — index wiped, triggering re-index`);

    // Reset disabled flags — user is explicitly choosing a model
    disabledByUser = false;
    disabledByHardware = false;
    setEnhancedSearchEnabledConfig(true);

    // Trigger re-indexing in the background
    void startTrackedIndexJob(currentConfig, 'search: post-model-change reindex failed');
  } finally {
    modelChangeInProgress = false;
  }
}

/**
 * Stop the search scheduler.
 */
export function stopSearchScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  activeJobToken++;
  abortController?.abort();
  running = false;
  runningJobPromise = null;
  abortController = null;
  currentConfig = null;
  jobProcessor = null;
  ensureProcessorPromise = null;
  disabledByUser = false;
  disabledByHardware = false;
  downloadProgress = null;
  modelChangeInProgress = false;
}

export async function setEnhancedSearchEnabled(enabled: boolean): Promise<void> {
  if (!currentConfig) {
    throw new Error('Search scheduler not initialized');
  }
  if (modelChangeInProgress) {
    throw new Error('Model change in progress');
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

  if (disabledByHardware) {
    disabledByHardware = false;
  }
}
