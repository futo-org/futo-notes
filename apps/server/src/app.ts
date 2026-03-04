import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { log } from './logger.js';
import { loadConfig } from './config.js';
import health from './routes/health.js';
import setup from './routes/setup.js';
import login from './routes/login.js';
import sync from './routes/sync.js';
import revoke from './routes/revoke.js';
import events from './routes/events.js';
import dev from './routes/dev.js';
import search from './routes/search.js';
import dashboard from './routes/dashboard.js';
import reset from './routes/reset.js';
import transforms from './routes/transforms.js';

export function createApp(): Hono {
  const app = new Hono();
  app.use('*', cors());

  // Request logging middleware
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    const status = c.res.status;
    const line = `→ ${c.req.method} ${c.req.path} ${status} (${ms}ms)`;
    if (status === 404) {
      log.warn(line);
    } else {
      log.info(line);
    }
  });

  app.route('/', dashboard);
  app.route('/', health);
  app.route('/', setup);
  app.route('/', login);
  app.route('/', sync);
  app.route('/', revoke);
  app.route('/', events);
  app.route('/', reset);

  // Search routes (only when search is enabled)
  const config = loadConfig();
  if (config.searchEnabled) {
    app.route('/', search);
  }

  // Transform routes (only when transforms are enabled)
  if (config.transformsEnabled) {
    app.route('/', transforms);
  }

  // Dev-only routes (nuke, etc.)
  if (process.env.NODE_ENV !== 'production') {
    app.route('/', dev);
  }

  // 404 fallback
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  // Global error handler
  app.onError((err, c) => {
    log.error(`${c.req.method} ${c.req.path} — ${err.message}`);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
