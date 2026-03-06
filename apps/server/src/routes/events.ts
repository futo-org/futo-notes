import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { sessionExists } from '../db/sessions.js';
import { getDb } from '../db/index.js';
import { addClient, issueSseTicket, removeClient, resolveSseTicket } from '../events.js';
import { authMiddleware, type AuthEnv } from '../middleware/auth.js';
import { log } from '../logger.js';

const events = new Hono<AuthEnv>();

events.post('/events/session', authMiddleware, (c) => {
  const tokenHash = c.get('tokenHash');
  return c.json({ ticket: issueSseTicket(tokenHash) });
});

events.get('/events', (c) => {
  const ticket = c.req.query('ticket');
  const clientId = c.req.query('clientId');

  if (!ticket || !clientId) {
    return c.json({ error: 'Missing ticket or clientId query parameter' }, 401);
  }

  const tokenH = resolveSseTicket(ticket);
  if (!tokenH) {
    return c.json({ error: 'Invalid or expired SSE ticket' }, 401);
  }

  const db = getDb();
  if (!sessionExists(db, tokenH)) {
    log.warn(`sse: rejected — invalid/revoked session for clientId=${clientId}`);
    return c.json({ error: 'Invalid or revoked session' }, 401);
  }

  return streamSSE(c, async (stream) => {
    addClient(clientId, tokenH, stream);

    await stream.writeSSE({ event: 'connected', data: '' });

    stream.onAbort(() => {
      removeClient(clientId);
    });

    // Keep the stream open — wait indefinitely
    await new Promise<void>((resolve) => {
      stream.onAbort(resolve);
    });
  });
});

export default events;
