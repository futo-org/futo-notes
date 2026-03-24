import { describe, it, expect, vi } from 'vitest';
import { authMiddleware } from '../../src/middleware/auth.js';

describe('authMiddleware direct invocation', () => {
  it('returns 401 when Bearer token is empty string', async () => {
    const json = vi.fn().mockImplementation((body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status }),
    );

    const mockContext = {
      req: {
        header: (name: string) => name === 'Authorization' ? 'Bearer ' : undefined,
        path: '/test',
      },
      json,
      set: vi.fn(),
    };

    const next = vi.fn();
    await authMiddleware(mockContext as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      { error: 'Missing or invalid Authorization header' },
      401,
    );
  });
});
