import path from 'node:path';

export interface Config {
  port: number;
  databasePath: string;
  notesPath: string;
  modelsPath: string;
  pluginsPath: string;
  searchEnabled: boolean;
  indexIdleStart: string;
  indexIdleEnd: string;
  indexMaxMemoryMb: number;
  indexBatchSize: number;
  pluginsEnabled: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: parseInt(env.PORT || '3005', 10),
    databasePath: env.DATABASE_PATH || path.join('data', 'stonefruit.db'),
    notesPath: env.NOTES_PATH || path.join('data', 'notes'),
    modelsPath: env.MODELS_PATH || path.join('data', 'models'),
    pluginsPath: env.PLUGINS_PATH || path.join('data', 'plugins'),
    searchEnabled: env.SEARCH_ENABLED !== 'false',
    indexIdleStart: env.INDEX_IDLE_START || '02:00',
    indexIdleEnd: env.INDEX_IDLE_END || '06:00',
    indexMaxMemoryMb: parseInt(env.INDEX_MAX_MEMORY_MB || '512', 10),
    indexBatchSize: parseInt(env.INDEX_BATCH_SIZE || '50', 10),
    pluginsEnabled: env.PLUGINS_ENABLED !== 'false' && env.TRANSFORMS_ENABLED !== 'false',
  };
}
