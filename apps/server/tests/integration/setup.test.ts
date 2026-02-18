import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, req, type TestEnv } from '../helpers/setup.js';

describe('POST /setup', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('succeeds with valid password', async () => {
    const res = await req(env.app, 'POST', '/setup', { password: 'validpassword' });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toEqual({ success: true });
  });

  it('rejects duplicate setup (409)', async () => {
    await req(env.app, 'POST', '/setup', { password: 'validpassword' });
    const res = await req(env.app, 'POST', '/setup', { password: 'anotherpassword' });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('already set');
  });

  it('rejects short password (422)', async () => {
    const res = await req(env.app, 'POST', '/setup', { password: 'short' });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toContain('8 characters');
  });

  it('rejects missing password (400)', async () => {
    const res = await req(env.app, 'POST', '/setup', {});
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON (400)', async () => {
    const res = await env.app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
