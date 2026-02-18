import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, req, type TestEnv } from '../helpers/setup.js';

describe('POST /login', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns 403 if setup not complete', async () => {
    const res = await req(env.app, 'POST', '/login', { password: 'anything' });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('Setup not complete');
  });

  it('succeeds with correct password', async () => {
    await req(env.app, 'POST', '/setup', { password: 'mypassword' });
    const res = await req(env.app, 'POST', '/login', { password: 'mypassword' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects wrong password (401)', async () => {
    await req(env.app, 'POST', '/setup', { password: 'mypassword' });
    const res = await req(env.app, 'POST', '/login', { password: 'wrongpass' });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('Invalid password');
  });

  it('rejects missing password (400)', async () => {
    await req(env.app, 'POST', '/setup', { password: 'mypassword' });
    const res = await req(env.app, 'POST', '/login', {});
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON (400)', async () => {
    await req(env.app, 'POST', '/setup', { password: 'mypassword' });
    const res = await env.app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
