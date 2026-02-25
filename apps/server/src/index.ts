import { serve } from '@hono/node-server';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig } from './config.js';
import { initDb, getDb } from './db/index.js';
import { createApp } from './app.js';
import { reconcile } from './sync/recovery.js';
import { log } from './logger.js';

function getLanAddress(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
}

const config = loadConfig();

log.info(`config: port=${config.port} db=${config.databasePath} notes=${config.notesPath}`);

// Ensure notes directory exists
fs.mkdirSync(config.notesPath, { recursive: true });

// Initialize database
initDb(config.databasePath);

// Reconcile DB with disk (recover from any crash-induced divergence)
log.info('reconciling DB with disk...');
reconcile(getDb(), config.notesPath);

// Conditional search init
if (config.searchEnabled) {
  log.info('search: enabled — initializing search tables and scheduler');
  const { createSearchTables } = await import('./db/searchSchema.js');
  createSearchTables(getDb());

  const { startSearchScheduler } = await import('./search/scheduler.js');
  startSearchScheduler(config);
}

// Create and start server
const app = createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const lan = getLanAddress();
  log.info(`listening on http://localhost:${info.port}`);
  if (lan) log.info(`           http://${lan}:${info.port}`);
});
