import type { Config } from '../config.js';
import { getDb } from '../db/index.js';
import { getDirtyUuids } from './dirtyTracker.js';
import { runIndexJob } from './jobRunner.js';
import { log } from '../logger.js';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastActivity = Date.now();
let running = false;
let currentConfig: Config | null = null;

// Track job processor — set by embeddingIndexer when loaded
let jobProcessor: ((db: import('better-sqlite3').Database, uuids: string[]) => Promise<void>) | null = null;

export function setJobProcessor(fn: (db: import('better-sqlite3').Database, uuids: string[]) => Promise<void>): void {
  jobProcessor = fn;
}

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
 * Trigger an indexing job immediately, bypassing the idle window.
 * Returns the job_id.
 */
export async function triggerIndexNow(): Promise<string> {
  if (!currentConfig) {
    throw new Error('Search scheduler not initialized');
  }
  if (running) {
    throw new Error('Index job already running');
  }

  const db = getDb();
  const level = 2; // embedding level
  running = true;
  try {
    const processor = jobProcessor ?? (async () => {
      log.warn('search: no job processor registered, skipping batch');
    });
    const result = await runIndexJob(db, level, currentConfig.indexBatchSize, processor);
    return result.jobId;
  } finally {
    running = false;
  }
}

async function tick(): Promise<void> {
  if (running || !currentConfig) return;

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
    const processor = jobProcessor ?? (async () => {
      log.warn('search: no job processor registered, skipping batch');
    });
    await runIndexJob(db, 2, config.indexBatchSize, processor);
  } catch (err) {
    log.error(`search: scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
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
}
