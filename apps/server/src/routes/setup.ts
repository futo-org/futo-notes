import { Hono } from 'hono';
import type { SetupRequest } from '@futo-notes/shared';
import { getDb } from '../db/index.js';
import { isSetupComplete, setPasswordHash } from '../db/auth.js';
import { hashPassword } from '../auth/password.js';

const setup = new Hono();

setup.post('/setup', async (c) => {
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
    return c.json({ error: 'Password already set' }, 409);
  }

  const hash = await hashPassword(body.password);
  setPasswordHash(db, hash);
  return c.json({ success: true }, 201);
});

export default setup;
