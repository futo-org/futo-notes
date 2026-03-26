import { Hono } from 'hono';
import type { ChangePasswordRequest, ChangePasswordResponse } from '@futo-notes/shared';
import { getDb } from '../db/index.js';
import { getPasswordHash, updatePasswordHash } from '../db/auth.js';
import { deleteAllSessions, createSession } from '../db/sessions.js';
import { verifyPassword, hashPassword, MAX_PASSWORD_LENGTH } from '../auth/password.js';
import { generateToken, hashToken } from '../auth/token.js';
import { authMiddleware, type AuthEnv } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { removeAllClients } from '../events.js';
import { log } from '../logger.js';

const changePassword = new Hono<AuthEnv>();

changePassword.post('/change-password', rateLimit(5), authMiddleware, async (c) => {
  let body: ChangePasswordRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.current_password || typeof body.current_password !== 'string') {
    return c.json({ error: 'Missing required field: current_password' }, 400);
  }
  if (!body.new_password || typeof body.new_password !== 'string') {
    return c.json({ error: 'Missing required field: new_password' }, 400);
  }
  if (body.new_password.length < 8) {
    return c.json({ error: 'New password must be at least 8 characters' }, 422);
  }
  if (body.new_password.length > MAX_PASSWORD_LENGTH) {
    return c.json({ error: `New password must not exceed ${MAX_PASSWORD_LENGTH} characters` }, 422);
  }

  const db = getDb();
  const storedHash = getPasswordHash(db);
  if (!storedHash) {
    return c.json({ error: 'Setup not complete' }, 403);
  }

  const valid = await verifyPassword(storedHash, body.current_password);
  if (!valid) {
    log.warn('change-password: invalid current password');
    return c.json({ error: 'Invalid current password' }, 401);
  }

  const newHash = await hashPassword(body.new_password);
  updatePasswordHash(db, newHash);

  // Revoke all sessions
  deleteAllSessions(db);

  // Disconnect all SSE clients
  removeAllClients();

  // Create a new session for the caller
  const token = generateToken();
  const tokenH = hashToken(token);
  createSession(db, tokenH);

  log.info('change-password: password changed, all sessions revoked');

  const resp: ChangePasswordResponse = { success: true, token };
  return c.json(resp);
});

export default changePassword;
