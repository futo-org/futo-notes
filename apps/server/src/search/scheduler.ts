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
let disabled = false;
let phase: SchedulerPhase = 'idle';

/**
 * Get the current scheduler state for dashboard display.
 */
export function getSchedulerState(): {
  phase: SchedulerPhase;
  modelReady: boolean;
  idleWindow: { start: string; end: string; active: boolean } | null;
} {
  if (!currentConfig) {
    return { phase: 'idle', modelReady: false, idleWindow: null };
  }
  return {
    phase: disabled ? 'disabled' : phase,
    modelReady: jobProcessor !== null,
    idleWindow: {
      start: currentConfig.indexIdleStart,
      end: currentConfig.indexIdleEnd,
      active: isWithinIdleWindow(currentConfig.indexIdleStart, currentConfig.indexIdleEnd),
    },
  };
}

// Track job processor — lazily initialized on first indexing trigger
let jobProcessor: ((db: import('better-sqlite3').Database, uuids: string[]) => Promise<void>) | null = null;

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
  if (disabled) return false;

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
        disabled = true;
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
      disabled = true;
      return false;
    }

    // Init vector DB with the model's dims
    const { initVectorDb } = await import('../db/vectorDb.js');
    await initVectorDb(db, modelDef.dims);

    // Load model (downloads if needed)
    phase = 'downloading_model';
    const { loadEmbeddingModel } = await import('./modelManager.js');
    phase = 'loading_model';
    const model = await loadEmbeddingModel(modelDef, config.modelsPath);

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

  running = true;
  const config = currentConfig;

  runIndexInBackground(config).catch((err) => {
    log.error(`search: manual reindex failed: ${err instanceof Error ? err.message : String(err)}`);
  }).finally(() => {
    running = false;
    phase = 'idle';
  });
}

async function runIndexInBackground(config: Config): Promise<void> {
  const ready = await ensureProcessor(config);
  if (!ready || !jobProcessor) {
    throw new Error('Embedding model not available (hardware too slow or model missing)');
  }
  const db = getDb();
  phase = 'indexing';
  await runIndexJob(db, 2, config.indexBatchSize, jobProcessor);

  // Build artifacts and notify clients
  phase = 'building_artifacts';
  const { buildArtifacts } = await import('./artifactBuilder.js');
  const artifactDir = path.join(path.dirname(config.databasePath), 'search-artifacts');
  await buildArtifacts(db, artifactDir);
  const { broadcastSupersearchReady } = await import('../events.js');
  broadcastSupersearchReady();
}

async function tick(): Promise<void> {
  if (running || !currentConfig || disabled) return;

  const config = currentConfig;
  const inWindow = isWithinIdleWindow(config.indexIdleStart, config.indexIdleEnd);
  const idleMs = Date.now() - lastActivity;
  const idleThresholdMs = 3 * 60 * 60 * 1000; // 3 hours

  if (!inWindow && idleMs < idleThresholdMs) return;

  const db = getDb();
  const dirtyCount = getDirtyUuids(db, 2).length;
  if (dirtyCount === 0) return;

  log.info(`search: scheduler triggered (inWindow=${inWindow} idle=${Math.round(idleMs / 60000)}min dirty=${dirtyCount})`);

  running = true;
  try {
    const ready = await ensureProcessor(config);
    if (!ready || !jobProcessor) return;

    phase = 'indexing';
    await runIndexJob(db, 2, config.indexBatchSize, jobProcessor);

    // Build artifacts and notify clients
    phase = 'building_artifacts';
    const { buildArtifacts } = await import('./artifactBuilder.js');
    const artifactDir = path.join(path.dirname(config.databasePath), 'search-artifacts');
    await buildArtifacts(db, artifactDir);
    const { broadcastSupersearchReady } = await import('../events.js');
    broadcastSupersearchReady();
  } catch (err) {
    log.error(`search: scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
    phase = 'idle';
  }
}

/**
 * Start the search scheduler. Checks every 60s if indexing should run.
 */
export function startSearchScheduler(config: Config): void {
  currentConfig = config;
  schedulerInterval = setInterval(() => {
    tick().catch((err) => {
      log.error(`search: scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 60_000);
  schedulerInterval.unref();
  log.info(`search: scheduler started (idle window ${config.indexIdleStart}-${config.indexIdleEnd})`);
}

/**
 * Stop the search scheduler.
 */
export function stopSearchScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  currentConfig = null;
  jobProcessor = null;
  disabled = false;
}
