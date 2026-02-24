import type Database from 'better-sqlite3';

export interface SearchCapabilities {
  levels: number[];
  model: string | null;
  dims: number | null;
  query_prefix: string | null;
  chunk_count: number;
  last_indexed_at: number | null;
  artifact_version: string | null;
  artifact_hash: string | null;
}

export interface SearchStatus {
  current_job: {
    job_id: string;
    level: number;
    status: string;
    started_at: number;
    notes_total: number | null;
    notes_processed: number;
  } | null;
  last_run: {
    job_id: string;
    level: number;
    status: string;
    started_at: number;
    finished_at: number | null;
    notes_total: number | null;
    notes_processed: number;
    error_message: string | null;
  } | null;
}

function getConfigValue(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM search_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getCapabilities(db: Database.Database): SearchCapabilities {
  const model = getConfigValue(db, 'embedding_model');
  const dims = getConfigValue(db, 'embedding_dims');
  const queryPrefix = getConfigValue(db, 'query_prefix');
  const artifactVersion = getConfigValue(db, 'artifact_version');
  const artifactHash = getConfigValue(db, 'artifact_hash');

  const chunkRow = db.prepare('SELECT COUNT(*) as count FROM search_chunks').get() as { count: number };

  const lastIndexed = db.prepare(`
    SELECT MAX(indexed_at) as last FROM search_index_state
  `).get() as { last: number | null };

  return {
    levels: model ? [2] : [],
    model,
    dims: dims ? parseInt(dims, 10) : null,
    query_prefix: queryPrefix,
    chunk_count: chunkRow.count,
    last_indexed_at: lastIndexed.last,
    artifact_version: artifactVersion,
    artifact_hash: artifactHash,
  };
}

export function getJobStatus(db: Database.Database): SearchStatus {
  const running = db.prepare(`
    SELECT job_id, level, status, started_at, notes_total, notes_processed
    FROM search_jobs WHERE status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `).get() as {
    job_id: string; level: number; status: string;
    started_at: number; notes_total: number | null; notes_processed: number;
  } | undefined;

  const lastRun = db.prepare(`
    SELECT job_id, level, status, started_at, finished_at, notes_total, notes_processed, error_message
    FROM search_jobs WHERE status IN ('completed', 'failed')
    ORDER BY finished_at DESC LIMIT 1
  `).get() as {
    job_id: string; level: number; status: string; started_at: number;
    finished_at: number | null; notes_total: number | null;
    notes_processed: number; error_message: string | null;
  } | undefined;

  return {
    current_job: running ? {
      job_id: running.job_id,
      level: running.level,
      status: running.status,
      started_at: running.started_at,
      notes_total: running.notes_total,
      notes_processed: running.notes_processed,
    } : null,
    last_run: lastRun ? {
      job_id: lastRun.job_id,
      level: lastRun.level,
      status: lastRun.status,
      started_at: lastRun.started_at,
      finished_at: lastRun.finished_at,
      notes_total: lastRun.notes_total,
      notes_processed: lastRun.notes_processed,
      error_message: lastRun.error_message,
    } : null,
  };
}
