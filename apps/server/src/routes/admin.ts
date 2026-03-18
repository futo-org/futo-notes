import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { updatePasswordHash } from '../db/auth.js';
import { deleteAllSessions } from '../db/sessions.js';
import { hashPassword } from '../auth/password.js';
import { getAdminToken } from '../auth/adminToken.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { removeAllClients } from '../events.js';
import { log } from '../logger.js';

const admin = new Hono();

admin.post('/admin/reset-password', rateLimit(3), async (c) => {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('AdminToken ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const providedToken = header.slice('AdminToken '.length);
  if (!providedToken) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const expectedToken = getAdminToken();
  if (!expectedToken) {
    return c.json({ error: 'Admin token not available' }, 401);
  }

  // Constant-time comparison
  const a = Buffer.from(providedToken, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    log.warn('admin: invalid admin token on reset-password');
    return c.json({ error: 'Invalid admin token' }, 401);
  }

  let body: { new_password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.new_password || typeof body.new_password !== 'string') {
    return c.json({ error: 'Missing required field: new_password' }, 400);
  }
  if (body.new_password.length < 8) {
    return c.json({ error: 'New password must be at least 8 characters' }, 422);
  }

  const db = getDb();
  const newHash = await hashPassword(body.new_password);
  updatePasswordHash(db, newHash);

  // Revoke all sessions and disconnect SSE clients
  deleteAllSessions(db);
  removeAllClients();

  log.info('admin: password reset via admin token, all sessions revoked');

  return c.json({ success: true });
});

export default admin;
