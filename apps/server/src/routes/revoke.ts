import { Hono } from 'hono';
import type { RevokeRequest, RevokeResponse } from '@futo-notes/shared';
import { authMiddleware, type AuthEnv } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { deleteSession, deleteAllSessions, deleteSessions } from '../db/sessions.js';
import { removeClientsByTokenHash, removeAllClients } from '../events.js';
import { log } from '../logger.js';

const revoke = new Hono<AuthEnv>();

revoke.post('/revoke', authMiddleware, async (c) => {
  let body: RevokeRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.mode || !['current', 'all', 'specific'].includes(body.mode)) {
    return c.json({ error: 'Invalid mode — must be "current", "all", or "specific"' }, 400);
  }

  const db = getDb();
  let revoked = 0;

  switch (body.mode) {
    case 'current': {
      const tokenHash = c.get('tokenHash');
      revoked = deleteSession(db, tokenHash);
      removeClientsByTokenHash(tokenHash);
      break;
    }
    case 'all': {
      revoked = deleteAllSessions(db);
      removeAllClients();
      break;
    }
    case 'specific': {
      if (!Array.isArray(body.token_hashes) || body.token_hashes.length === 0) {
        return c.json({ error: 'token_hashes required for mode "specific"' }, 400);
      }
      revoked = deleteSessions(db, body.token_hashes);
      for (const hash of body.token_hashes) {
        removeClientsByTokenHash(hash);
      }
      break;
    }
  }

  log.info(`revoke mode=${body.mode} revoked=${revoked}`);

  const resp: RevokeResponse = { revoked };
  return c.json(resp);
});

export default revoke;
