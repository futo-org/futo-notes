import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { createTables } from '../db/schema.js';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';

const dev = new Hono();

dev.post('/dev/nuke', (c) => {
  const db = getDb();
  const config = loadConfig();

  log.warn('NUKE — wiping all data');

  // Drop all tables and recreate
  db.exec(`
    DROP TABLE IF EXISTS tombstones;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS auth;
  `);
  createTables(db);

  // Wipe notes directory
  const notesDir = path.resolve(config.notesPath);
  if (fs.existsSync(notesDir)) {
    fs.rmSync(notesDir, { recursive: true });
    fs.mkdirSync(notesDir, { recursive: true });
  }

  log.warn('NUKE complete — server reset to fresh state');
  return c.json({ success: true, message: 'Server wiped clean' });
});

export default dev;
