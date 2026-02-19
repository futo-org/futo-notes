import type { Context, Next } from 'hono';
import { hashToken } from '../auth/token.js';
import { sessionExists } from '../db/sessions.js';
import { getDb } from '../db/index.js';
import { log } from '../logger.js';

/** Hono env type for routes behind auth middleware. */
export type AuthEnv = { Variables: { tokenHash: string } };

export async function authMiddleware(c: Context<AuthEnv>, next: Next): Promise<Response | void> {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    log.warn(`auth: missing/invalid Authorization header on ${c.req.path}`);
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = header.slice(7);
  if (!token) {
    log.warn(`auth: empty token on ${c.req.path}`);
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const tokenH = hashToken(token);
  const db = getDb();
  if (!sessionExists(db, tokenH)) {
    log.warn(`auth: invalid/revoked session on ${c.req.path}`);
    return c.json({ error: 'Invalid or revoked session' }, 401);
  }

  log.debug(`auth: session validated for ${c.req.path}`);
  c.set('tokenHash', tokenH);
  await next();
}
