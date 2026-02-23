import path from 'node:path';

export interface Config {
  port: number;
  databasePath: string;
  notesPath: string;
  searchEnabled: boolean;
  indexIdleStart: string;
  indexIdleEnd: string;
  indexMaxMemoryMb: number;
  indexBatchSize: number;
  embeddingModel?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: parseInt(env.PORT || '3005', 10),
    databasePath: env.DATABASE_PATH || path.join('data', 'futo-notes.db'),
    notesPath: env.NOTES_PATH || path.join('data', 'notes'),
    searchEnabled: env.SEARCH_ENABLED === 'true',
    indexIdleStart: env.INDEX_IDLE_START || '02:00',
    indexIdleEnd: env.INDEX_IDLE_END || '06:00',
    indexMaxMemoryMb: parseInt(env.INDEX_MAX_MEMORY_MB || '512', 10),
    indexBatchSize: parseInt(env.INDEX_BATCH_SIZE || '50', 10),
    embeddingModel: env.EMBEDDING_MODEL || undefined,
  };
}
