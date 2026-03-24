import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function createMockContext(ip: string, reqPath: string, onJson?: (status: number) => void) {
  return {
    env: {},
    req: {
      header: (name: string) => name === 'x-forwarded-for' ? ip : undefined,
      path: reqPath,
    },
    json: (_body: unknown, status: number) => {
      onJson?.(status);
      return { status };
    },
  };
}

describe('rateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cleans up expired entries after 5 minutes', async () => {
    vi.resetModules();
    const { rateLimit, clearRateLimitStore } = await import('../../src/middleware/rateLimit.js');

    const next = vi.fn();
    const middleware = rateLimit(100);

    await middleware(createMockContext('1.2.3.4', '/test') as any, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Advance past the 60s window + the 5-minute cleanup interval
    vi.advanceTimersByTime(361_000);

    await middleware(createMockContext('1.2.3.4', '/test') as any, next);
    expect(next).toHaveBeenCalledTimes(2);

    clearRateLimitStore();
  });

  it('rate limits when too many requests in window', async () => {
    vi.resetModules();
    const { rateLimit, clearRateLimitStore } = await import('../../src/middleware/rateLimit.js');

    const responses: number[] = [];
    const next = vi.fn();
    const middleware = rateLimit(3);

    for (let i = 0; i < 3; i++) {
      await middleware(createMockContext('10.0.0.1', '/login') as any, next);
    }
    expect(next).toHaveBeenCalledTimes(3);

    await middleware(
      createMockContext('10.0.0.1', '/login', (s) => responses.push(s)) as any,
      next,
    );
    expect(next).toHaveBeenCalledTimes(3);
    expect(responses).toContain(429);

    clearRateLimitStore();
  });
});
