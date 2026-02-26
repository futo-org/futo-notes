import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Config } from '../../src/config.js';

describe('changeModel', () => {
  let db: Database.Database;
  let tmpDir: string;
  let intervalCallback: (() => void) | null = null;
  let runIndexInvocation = 0;
  const events: string[] = [];
  let firstRunStartedResolve: (() => void) | null = null;
  let firstRunAbortedResolve: (() => void) | null = null;
  let firstRunStarted: Promise<void>;
  let firstRunAborted: Promise<void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-scheduler-change-model-'));
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE search_chunks (
        chunk_id INTEGER PRIMARY KEY,
        uuid TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE TABLE search_index_state (
        uuid TEXT NOT NULL,
        level INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        PRIMARY KEY (uuid, level)
      );
      CREATE TABLE search_jobs (
        job_id TEXT PRIMARY KEY,
        level INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        notes_total INTEGER NOT NULL,
        notes_processed INTEGER NOT NULL,
        checkpoint TEXT,
        error_message TEXT
      );
      CREATE TABLE search_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE search_vectors (
        chunk_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL
      );
    `);

    db.prepare(
      "INSERT INTO search_chunks (chunk_id, uuid, chunk_index, chunk_text, start_offset, end_offset, content_hash) VALUES (1, 'u1', 0, 'seed', 0, 4, 'h1')",
    ).run();
    db.prepare(
      "INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES ('u1', 2, 'h1', 1)",
    ).run();
    db.prepare(
      "INSERT INTO search_jobs (job_id, level, status, started_at, notes_total, notes_processed) VALUES ('old-job', 2, 'completed', 1, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO search_config (key, value, updated_at) VALUES ('embedding_model', 'old-model', 1), ('embedding_dims', '8', 1), ('artifact_version', 'supersearch-v1', 1), ('artifact_hash', 'deadbeef', 1)",
    ).run();
    db.prepare("INSERT INTO search_vectors (chunk_id, embedding) VALUES (1, x'00')").run();

    const originalExec = db.exec.bind(db);
    (db as unknown as { exec: (sql: string) => void }).exec = (sql: string): void => {
      if (sql.includes('DELETE FROM search_chunks')) {
        events.push('wipe-start');
      }
      originalExec(sql);
    };

    firstRunStarted = new Promise<void>((resolve) => { firstRunStartedResolve = resolve; });
    firstRunAborted = new Promise<void>((resolve) => { firstRunAbortedResolve = resolve; });

    vi.spyOn(globalThis, 'setInterval').mockImplementation(((cb: TimerHandler) => {
      intervalCallback = cb as () => void;
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    vi.doMock('../../src/db/index.js', () => ({
      getDb: () => db,
    }));
    vi.doMock('../../src/search/dirtyTracker.js', () => ({
      getDirtyUuids: () => ['u1'],
    }));
    vi.doMock('../../src/search/jobRunner.js', () => ({
      runIndexJob: async (
        _db: Database.Database,
        _level: number,
        _batchSize: number,
        _processBatch: (db: Database.Database, uuids: string[]) => Promise<void>,
        signal?: AbortSignal,
      ) => {
        runIndexInvocation += 1;
        if (runIndexInvocation === 1) {
          events.push('run-1-start');
          firstRunStartedResolve?.();
          while (!signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          events.push('run-1-aborted');
          firstRunAbortedResolve?.();
          return { jobId: 'j1', status: 'interrupted', notesProcessed: 0, notesTotal: 1 };
        }

        events.push(`run-${runIndexInvocation}-start`);
        return { jobId: `j${runIndexInvocation}`, status: 'completed', notesProcessed: 0, notesTotal: 0 };
      },
    }));
    vi.doMock('../../src/search/modelRegistry.js', () => ({
      getModelDef: (id: string) => ({
        id,
        hfUri: 'hf:test/model',
        nativeDims: 8,
        dims: 8,
        sizeBytes: 1,
        queryPrefix: null,
        docPrefix: null,
      }),
    }));
    vi.doMock('../../src/db/vectorDb.js', () => ({
      initVectorDb: async () => undefined,
      resetVectorDb: () => undefined,
    }));
    vi.doMock('../../src/search/modelManager.js', () => ({
      loadEmbeddingModel: async () => ({
        model: { dispose: async () => undefined },
        context: { dispose: async () => undefined },
        dims: 8,
        queryPrefix: null,
        docPrefix: null,
        embedDocuments: async (texts: string[]) => texts.map(() => Array(8).fill(0)),
        embedQuery: async () => Array(8).fill(0),
      }),
      unloadModel: async () => undefined,
    }));
    vi.doMock('../../src/search/embeddingIndexer.js', () => ({
      createEmbeddingProcessor: () => async () => undefined,
    }));
    vi.doMock('../../src/search/artifactBuilder.js', () => ({
      buildArtifacts: async () => ({ version: 'supersearch-v1', hash: 'abc123' }),
    }));
    vi.doMock('../../src/events.js', () => ({
      broadcastSupersearchReady: () => undefined,
    }));
    vi.doMock('../../src/logger.js', () => ({
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    }));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore close errors in tests
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('waits for an in-flight scheduled job to abort before wiping index state', async () => {
    const scheduler = await import('../../src/search/scheduler.js');

    const config: Config = {
      port: 3005,
      databasePath: path.join(tmpDir, 'test.db'),
      notesPath: path.join(tmpDir, 'notes'),
      modelsPath: path.join(tmpDir, 'models'),
      searchEnabled: true,
      indexIdleStart: '00:00',
      indexIdleEnd: '23:59',
      indexMaxMemoryMb: 512,
      indexBatchSize: 10,
    };
    scheduler.startSearchScheduler(config);

    expect(intervalCallback).not.toBeNull();
    intervalCallback?.();
    await firstRunStarted;

    await scheduler.changeModel('new-model');
    await firstRunAborted;

    const abortedAt = events.indexOf('run-1-aborted');
    const wipedAt = events.indexOf('wipe-start');
    expect(abortedAt).toBeGreaterThanOrEqual(0);
    expect(wipedAt).toBeGreaterThanOrEqual(0);
    expect(abortedAt).toBeLessThan(wipedAt);

    const chunks = db.prepare('SELECT COUNT(*) as count FROM search_chunks').get() as { count: number };
    const states = db.prepare('SELECT COUNT(*) as count FROM search_index_state').get() as { count: number };
    const jobs = db.prepare('SELECT COUNT(*) as count FROM search_jobs').get() as { count: number };
    const vectors = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='search_vectors'").get() as { count: number };
    const model = db.prepare("SELECT value FROM search_config WHERE key='embedding_model'").get() as { value: string };
    const artifactHash = db.prepare("SELECT value FROM search_config WHERE key='artifact_hash'").get() as { value: string } | undefined;

    expect(chunks.count).toBe(0);
    expect(states.count).toBe(0);
    expect(jobs.count).toBe(0);
    expect(vectors.count).toBe(0);
    expect(model.value).toBe('new-model');
    expect(artifactHash).toBeUndefined();

    scheduler.stopSearchScheduler();
  });
});
