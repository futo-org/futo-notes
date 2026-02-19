import path from 'node:path';

export interface Config {
  port: number;
  databasePath: string;
  notesPath: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: parseInt(env.PORT || '3005', 10),
    databasePath: env.DATABASE_PATH || path.join('data', 'futo-notes.db'),
    notesPath: env.NOTES_PATH || path.join('data', 'notes'),
  };
}
