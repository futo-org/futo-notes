import { Hono } from 'hono';
import type { ChangePasswordRequest, ChangePasswordResponse } from '@futo-notes/shared';
import { getDb } from '../db/index.js';
import { getPasswordHash, updatePasswordHash } from '../db/auth.js';
import { deleteAllSessions, createSession } from '../db/sessions.js';
import { verifyPassword, hashPassword } from '../auth/password.js';
import { generateToken, hashToken } from '../auth/token.js';
import { authMiddleware, type AuthEnv } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { removeAllClients } from '../events.js';
import { log } from '../logger.js';
import { parseJsonBody, validatePassword } from './helpers.js';

const changePassword = new Hono<AuthEnv>();

changePassword.post('/change-password', rateLimit(5), authMiddleware, async (c) => {
  const parsed = await parseJsonBody<ChangePasswordRequest>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  const curPwErr = validatePassword(body.current_password, 'current_password', 'Current password', { skipMinLength: true, skipMaxLength: true });
  if (curPwErr) return c.json({ error: curPwErr.error }, curPwErr.status);
  const newPwErr = validatePassword(body.new_password, 'new_password', 'New password');
  if (newPwErr) return c.json({ error: newPwErr.error }, newPwErr.status);

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
