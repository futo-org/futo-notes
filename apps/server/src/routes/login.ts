import { Hono } from 'hono';
import type { LoginRequest, LoginResponse } from '@futo-notes/shared';
import { getDb } from '../db/index.js';
import { getPasswordHash, isSetupComplete } from '../db/auth.js';
import { createSession } from '../db/sessions.js';
import { verifyPassword } from '../auth/password.js';
import { generateToken, hashToken } from '../auth/token.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { log } from '../logger.js';

const login = new Hono();

login.post('/login', rateLimit(5), async (c) => {
  const db = getDb();

  if (!isSetupComplete(db)) {
    return c.json({ error: 'Setup not complete — call POST /setup first' }, 403);
  }

  let body: LoginRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.password || typeof body.password !== 'string') {
    return c.json({ error: 'Missing required field: password' }, 400);
  }

  const storedHash = getPasswordHash(db)!;
  const valid = await verifyPassword(storedHash, body.password);
  if (!valid) {
    log.warn(`login failed${body.device_info ? ` (device: ${body.device_info})` : ''}`);
    return c.json({ error: 'Invalid password' }, 401);
  }

  const token = generateToken();
  const tokenH = hashToken(token);
  createSession(db, tokenH, body.device_info);

  log.info(`login success${body.device_info ? ` (device: ${body.device_info})` : ''}`);

  const resp: LoginResponse = { token };
  return c.json(resp);
});

export default login;
