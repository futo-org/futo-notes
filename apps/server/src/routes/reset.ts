import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import { performServerReset } from '../resetServer.js';

interface ResetRequest {
  confirmation?: string;
}

const reset = new Hono<AuthEnv>();

reset.post('/reset', authMiddleware, async (c) => {
  let body: ResetRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (body.confirmation !== 'DELETE') {
    return c.json({ error: 'Confirmation mismatch — send confirmation as "DELETE"' }, 400);
  }

  const db = getDb();
  const config = loadConfig();
  const result = await performServerReset(db, config, 'RESET');
  return c.json(result);
});

export default reset;
