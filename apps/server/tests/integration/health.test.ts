import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, req, setupAndLogin, type TestEnv } from '../helpers/setup.js';

describe('GET /health', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns ok with setup_complete false before setup', async () => {
    const res = await req(env.app, 'GET', '/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: 'ok', setup_complete: false });
  });

  it('returns ok with setup_complete true after setup', async () => {
    await setupAndLogin(env.app);
    const res = await req(env.app, 'GET', '/health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: 'ok', setup_complete: true });
  });
});
