import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SmartTransform, GenerateFn, TransformResult } from './types.js';
import { log } from '../logger.js';

export interface TransformJobResult {
  jobId: string;
  transformId: string;
  status: 'completed' | 'failed' | 'interrupted';
  notesProcessed: number;
  notesTotal: number;
  results: TransformResult[];
  error?: string;
}

/**
 * Run a transform on its pending notes in batches.
 * Checkpoints after each batch for resumability.
 */
export async function runTransformJob(
  db: Database.Database,
  transform: SmartTransform,
  notesPath: string,
  config: Record<string, unknown>,
  generate: GenerateFn,
  batchSize: number,
  signal: AbortSignal,
  opts?: { force?: boolean },
): Promise<TransformJobResult> {
  const jobId = crypto.randomUUID();
  const pendingUuids = transform.getPendingNotes(db, { force: opts?.force });

  if (pendingUuids.length === 0) {
    log.debug(`transforms: no pending notes for "${transform.id}", skipping`);
    return { jobId, transformId: transform.id, status: 'completed', notesProcessed: 0, notesTotal: 0, results: [] };
  }

  // Check for an interrupted job and resume from checkpoint
  const interrupted = db.prepare(`
    SELECT job_id, checkpoint FROM transform_jobs
    WHERE transform_id = ? AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `).get(transform.id) as { job_id: string; checkpoint: string | null } | undefined;

  let skipSet = new Set<string>();
  if (interrupted) {
    db.prepare(`UPDATE transform_jobs SET status = 'interrupted', finished_at = ? WHERE job_id = ?`)
      .run(Date.now(), interrupted.job_id);
    if (interrupted.checkpoint) {
      try {
        const processed = JSON.parse(interrupted.checkpoint) as string[];
        skipSet = new Set(processed);
      } catch { /* ignore bad checkpoint */ }
    }
  }

  const uuidsToProcess = pendingUuids.filter((u) => !skipSet.has(u));
  const notesTotal = uuidsToProcess.length;

  if (notesTotal === 0) {
    return { jobId, transformId: transform.id, status: 'completed', notesProcessed: 0, notesTotal: 0, results: [] };
  }

  // Create job record
  db.prepare(`
    INSERT INTO transform_jobs (job_id, transform_id, status, started_at, notes_total, notes_processed)
    VALUES (?, ?, 'running', ?, ?, 0)
  `).run(jobId, transform.id, Date.now(), notesTotal);

  log.info(`transforms: started job ${jobId} transform="${transform.id}" notes=${notesTotal}`);

  const processedUuids: string[] = [...skipSet];
  let notesProcessed = 0;
  const allResults: TransformResult[] = [];

  try {
    for (let i = 0; i < uuidsToProcess.length; i += batchSize) {
      if (signal.aborted) {
        db.prepare(`UPDATE transform_jobs SET status = 'interrupted', finished_at = ? WHERE job_id = ?`)
          .run(Date.now(), jobId);
        log.info(`transforms: job ${jobId} cancelled after ${notesProcessed} notes`);
        return { jobId, transformId: transform.id, status: 'interrupted', notesProcessed, notesTotal, results: allResults };
      }

      const batch = uuidsToProcess.slice(i, i + batchSize);
      const results = await transform.execute(db, notesPath, batch, config, generate, signal);
      allResults.push(...results);
      processedUuids.push(...batch);
      notesProcessed += batch.length;

      // Save checkpoint
      db.prepare(`
        UPDATE transform_jobs SET notes_processed = ?, checkpoint = ? WHERE job_id = ?
      `).run(notesProcessed, JSON.stringify(processedUuids), jobId);
    }

    // Mark completed
    db.prepare(`UPDATE transform_jobs SET status = 'completed', finished_at = ? WHERE job_id = ?`)
      .run(Date.now(), jobId);

    log.info(`transforms: completed job ${jobId} processed=${notesProcessed} actions=${allResults.length}`);
    return { jobId, transformId: transform.id, status: 'completed', notesProcessed, notesTotal, results: allResults };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE transform_jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE job_id = ?`)
      .run(Date.now(), message, jobId);
    log.error(`transforms: job ${jobId} failed: ${message}`);
    return { jobId, transformId: transform.id, status: 'failed', notesProcessed, notesTotal, results: allResults, error: message };
  }
}
