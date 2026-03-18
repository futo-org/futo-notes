import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import { performServerReset } from '../resetServer.js';

const dev = new Hono();

dev.post('/dev/nuke', async (c) => {
  if (process.env.NODE_ENV === 'production') return c.json({ error: 'Not available' }, 404);
  const db = getDb();
  const config = loadConfig();

  const result = await performServerReset(db, config, 'NUKE');
  return c.json({ ...result, message: 'Server wiped clean' });
});

export default dev;
