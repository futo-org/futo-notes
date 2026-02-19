import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { initDb, getDb } from './db/index.js';
import { createApp } from './app.js';
import { reconcile } from './sync/recovery.js';
import { log } from './logger.js';
import fs from 'node:fs';

const config = loadConfig();

log.info(`config: port=${config.port} db=${config.databasePath} notes=${config.notesPath}`);

// Ensure notes directory exists
fs.mkdirSync(config.notesPath, { recursive: true });

// Initialize database
initDb(config.databasePath);

// Reconcile DB with disk (recover from any crash-induced divergence)
log.info('reconciling DB with disk...');
reconcile(getDb(), config.notesPath);

// Create and start server
const app = createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info(`listening on http://localhost:${info.port}`);
});
