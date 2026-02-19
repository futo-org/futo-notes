import { Hono } from 'hono';
import type { SetupRequest } from '@futo-notes/shared';
import { getDb } from '../db/index.js';
import { isSetupComplete, setPasswordHash } from '../db/auth.js';
import { hashPassword } from '../auth/password.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { log } from '../logger.js';

const setup = new Hono();

setup.post('/setup', rateLimit(5), async (c) => {
  let body: SetupRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.password || typeof body.password !== 'string') {
    return c.json({ error: 'Missing required field: password' }, 400);
  }

  if (body.password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 422);
  }

  const db = getDb();
  if (isSetupComplete(db)) {
    log.warn('setup rejected — password already set');
    return c.json({ error: 'Password already set' }, 409);
  }

  const hash = await hashPassword(body.password);
  setPasswordHash(db, hash);
  log.info('setup complete — password configured');
  return c.json({ success: true }, 201);
});

export default setup;
