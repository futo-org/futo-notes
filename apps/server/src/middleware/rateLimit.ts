import type { Context, Next } from 'hono';
import { log } from '../logger.js';

interface Entry {
  timestamps: number[];
}

const store = new Map<string, Entry>();

/** Clear all rate limit state. Exported for testing. */
export function clearRateLimitStore(): void {
  store.clear();
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 60_000);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}, 300_000).unref();

/**
 * Sliding-window rate limiter. Tracks attempts per IP per route.
 * Returns 429 if the limit is exceeded within the 60s window.
 */
export function rateLimit(maxAttempts: number) {
  return async (c: Context, next: Next) => {
    const socketAddr = (c.env as any)?.incoming?.socket?.remoteAddress;
    const ip = socketAddr || c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Drop timestamps older than 60s
    entry.timestamps = entry.timestamps.filter((t) => now - t < 60_000);

    if (entry.timestamps.length >= maxAttempts) {
      log.warn(`rate limit exceeded: ip=${ip} path=${c.req.path}`);
      return c.json({ error: 'Too many requests — try again later' }, 429);
    }

    entry.timestamps.push(now);
    await next();
  };
}
