import { Hono } from 'hono';
import health from './routes/health.js';
import setup from './routes/setup.js';
import login from './routes/login.js';
import sync from './routes/sync.js';
import revoke from './routes/revoke.js';

export function createApp(): Hono {
  const app = new Hono();

  app.route('/', health);
  app.route('/', setup);
  app.route('/', login);
  app.route('/', sync);
  app.route('/', revoke);

  // 404 fallback
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  // Global error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
