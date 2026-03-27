import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDirtyUuids } from './dirtyTracker.js';
import { log } from '../logger.js';

export type ProcessBatchFn = (db: Database.Database, uuids: string[]) => Promise<void>;

export interface JobResult {
  jobId: string;
  status: 'completed' | 'failed' | 'interrupted';
  notesProcessed: number;
  notesTotal: number;
  error?: string;
}

/**
 * Run an indexing job for a given level.
 * Processes dirty UUIDs in batches, checkpointing after each batch.
 * Takes a processBatch callback so it can be used by different index levels.
 */
export async function runIndexJob(
  db: Database.Database,
  level: number,
  batchSize: number,
  processBatch: ProcessBatchFn,
  signal?: AbortSignal,
): Promise<JobResult> {
  const jobId = crypto.randomUUID();
  const dirtyUuids = getDirtyUuids(db, level);

  if (dirtyUuids.length === 0) {
    log.debug(`search: no dirty notes for level ${level}, skipping job`);
    return { jobId, status: 'completed', notesProcessed: 0, notesTotal: 0 };
  }

  // Check for an interrupted job and resume from checkpoint
  const interrupted = db.prepare(`
    SELECT job_id, checkpoint FROM search_jobs
    WHERE level = ? AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `).get(level) as { job_id: string; checkpoint: string | null } | undefined;

  let skipSet = new Set<string>();
  if (interrupted) {
    // Mark the old job as interrupted
    db.prepare(`UPDATE search_jobs SET status = 'interrupted', finished_at = ? WHERE job_id = ?`)
      .run(Date.now(), interrupted.job_id);
    if (interrupted.checkpoint) {
      try {
        const processed = JSON.parse(interrupted.checkpoint) as string[];
        skipSet = new Set(processed);
      } catch { /* ignore bad checkpoint */ }
    }
  }

  const uuidsToProcess = dirtyUuids.filter((u) => !skipSet.has(u));
  const notesTotal = uuidsToProcess.length;

  if (notesTotal === 0) {
    return { jobId, status: 'completed', notesProcessed: 0, notesTotal: 0 };
  }

  // Create job record
  db.prepare(`
    INSERT INTO search_jobs (job_id, level, status, started_at, notes_total, notes_processed)
    VALUES (?, ?, 'running', ?, ?, 0)
  `).run(jobId, level, Date.now(), notesTotal);

  log.info(`search: started job ${jobId} level=${level} notes=${notesTotal}`);

  const processedUuids: string[] = [...skipSet];
  let notesProcessed = 0;

  try {
    for (let i = 0; i < uuidsToProcess.length; i += batchSize) {
      if (signal?.aborted) {
        db.prepare(`UPDATE search_jobs SET status = 'interrupted', finished_at = ? WHERE job_id = ?`)
          .run(Date.now(), jobId);
        log.info(`search: job ${jobId} cancelled after ${notesProcessed} notes`);
        return { jobId, status: 'interrupted', notesProcessed, notesTotal };
      }

      const batch = uuidsToProcess.slice(i, i + batchSize);
      await processBatch(db, batch);
      processedUuids.push(...batch);
      notesProcessed += batch.length;

      // Save checkpoint
      db.prepare(`
        UPDATE search_jobs SET notes_processed = ?, checkpoint = ? WHERE job_id = ?
      `).run(notesProcessed, JSON.stringify(processedUuids), jobId);

      log.info(`search: job ${jobId} progress ${notesProcessed}/${notesTotal}`);
    }

    // Mark completed
    db.prepare(`UPDATE search_jobs SET status = 'completed', finished_at = ? WHERE job_id = ?`)
      .run(Date.now(), jobId);

    log.info(`search: completed job ${jobId} processed=${notesProcessed}`);
    return { jobId, status: 'completed', notesProcessed, notesTotal };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE search_jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE job_id = ?`)
      .run(Date.now(), message, jobId);
    log.error(`search: job ${jobId} failed: ${message}`);
    return { jobId, status: 'failed', notesProcessed, notesTotal, error: message };
  }
}
