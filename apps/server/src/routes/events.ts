import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { hashToken } from '../auth/token.js';
import { sessionExists } from '../db/sessions.js';
import { getDb } from '../db/index.js';
import { addClient, removeClient } from '../events.js';
import { log } from '../logger.js';

const events = new Hono();

events.get('/events', (c) => {
  const token = c.req.query('token');
  const clientId = c.req.query('clientId');

  if (!token || !clientId) {
    return c.json({ error: 'Missing token or clientId query parameter' }, 401);
  }

  const tokenH = hashToken(token);
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
