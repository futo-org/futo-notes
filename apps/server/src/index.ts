import { serve } from '@hono/node-server';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig } from './config.js';
import { initDb, getDb } from './db/index.js';
import { isSetupComplete, setPasswordHash } from './db/auth.js';
import { hashPassword } from './auth/password.js';
import { createApp } from './app.js';
import { reconcile } from './sync/recovery.js';
import { log } from './logger.js';
import { ensurePluginDirectories } from './plugins/loader.js';

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
ensurePluginDirectories(config);

// Initialize database
initDb(config.databasePath);

if (process.env.NODE_ENV === 'development') {
  const db = getDb();
  if (!isSetupComplete(db)) {
    const hash = await hashPassword('testing123');
    setPasswordHash(db, hash);
    log.info('dev: default password configured');
  }

  const devSeedNotes = [
    {
      filename: 'Welcome test note.md',
      body: '# Welcome test note\n\nThis development seed note is intentionally longer than ten words so it is always eligible for indexing during local server testing.\n',
    },
    {
      filename: 'Second test note.md',
      body: '# Second test note\n\nUse this note to verify indexing and search behavior with enough content words to satisfy the minimum chunking requirement every time.\n',
    },
  ];

  for (const note of devSeedNotes) {
    const fullPath = `${config.notesPath}/${note.filename}`;
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, note.body, 'utf8');
    }
  }
}

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

// Conditional plugins init
if (config.pluginsEnabled) {
  log.info('plugins: enabled — initializing tables and scheduler');
  const { createPluginTables } = await import('./db/pluginSchema.js');
  createPluginTables(getDb());

  const { syncBuiltinPlugins } = await import('./plugins/loader.js');
  syncBuiltinPlugins(getDb(), config);

  const { startPluginScheduler } = await import('./plugins/scheduler.js');
  startPluginScheduler(config);
}

// Create and start server
const app = createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const lan = getLanAddress();
  log.info(`listening on http://localhost:${info.port}`);
  if (lan) log.info(`           http://${lan}:${info.port}`);
});
