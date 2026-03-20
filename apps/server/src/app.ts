import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { log } from './logger.js';
import { loadConfig } from './config.js';
import health from './routes/health.js';
import setup from './routes/setup.js';
import login from './routes/login.js';
import sync from './routes/sync.js';
import blobSync from './routes/blobSync.js';
import revoke from './routes/revoke.js';
import events from './routes/events.js';
import dev from './routes/dev.js';
import search from './routes/search.js';
import dashboard from './routes/dashboard.js';
import reset from './routes/reset.js';
import changePassword from './routes/changePassword.js';
import admin from './routes/admin.js';
import plugins from './routes/plugins.js';
import { recordActivity } from './search/scheduler.js';
import { recordPluginActivity } from './plugins/scheduler.js';

/** Check whether an origin is allowed by the CORS policy. */
function isAllowedOrigin(origin: string, extraOrigins: string[]): boolean {
  // Tauri webview origins:
  //   desktop/iOS: tauri://localhost
  //   macOS/Windows: https://tauri.localhost
  //   Android: http://tauri.localhost
  if (origin === 'tauri://localhost' || /^https?:\/\/tauri\.localhost$/.test(origin)) {
    return true;
  }
  // Local development (any port on localhost / 127.0.0.1)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }
  // Additional origins from CORS_ORIGINS env var
  if (extraOrigins.includes(origin)) {
    return true;
  }
  return false;
}

export function createApp(): Hono {
  const app = new Hono();
  const config = loadConfig();
  app.use('*', cors({
    origin: (origin) => {
      // Tauri webview sends a null/empty origin — allow it.
      // iOS WKWebView sends the literal string "null" for custom URL schemes (tauri://).
      if (!origin || origin === 'null') return '*';
      return isAllowedOrigin(origin, config.corsOrigins) ? origin : '';
    },
  }));

  // Request logging middleware
  app.use('*', async (c, next) => {
    if (c.req.path !== '/health') {
      recordActivity();
      recordPluginActivity();
    }
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
  app.route('/', blobSync);
  app.route('/', revoke);
  app.route('/', events);
  app.route('/', reset);
  app.route('/', changePassword);
  app.route('/', admin);

  // Search routes (only when search is enabled)
  if (config.searchEnabled) {
    app.route('/', search);
  }

  // Plugin routes (only when plugins are enabled)
  if (config.pluginsEnabled) {
    app.route('/', plugins);
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
