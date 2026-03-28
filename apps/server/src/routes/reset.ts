import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import { performServerReset } from '../resetServer.js';
import { parseJsonBody } from './helpers.js';

interface ResetRequest {
  confirmation?: string;
}

const reset = new Hono<AuthEnv>();

reset.post('/reset', authMiddleware, async (c) => {
  const parsed = await parseJsonBody<ResetRequest>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  if (body.confirmation !== 'DELETE') {
    return c.json({ error: 'Confirmation mismatch — send confirmation as "DELETE"' }, 400);
  }

  const db = getDb();
  const config = loadConfig();
  const result = await performServerReset(db, config, 'RESET');
  return c.json(result);
});

export default reset;
