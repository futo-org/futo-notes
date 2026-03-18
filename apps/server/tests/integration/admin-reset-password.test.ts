import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, req, setupAndLogin, type TestEnv } from '../helpers/setup.js';
import { generateAdminToken, getAdminToken } from '../../src/auth/adminToken.js';
import { clearRateLimitStore } from '../../src/middleware/rateLimit.js';

describe('POST /admin/reset-password', () => {
  let env: TestEnv;
  const PASSWORD = 'testpassword123';

  beforeEach(() => {
    env = createTestEnv();
    generateAdminToken();
  });

  afterEach(() => {
    env.cleanup();
  });

  function adminReq(body: unknown, token?: string) {
    const adminToken = token ?? getAdminToken()!;
    return req(env.app, 'POST', '/admin/reset-password', body, {
      Authorization: `AdminToken ${adminToken}`,
    });
  }

  it('valid admin token + new password succeeds', async () => {
    await setupAndLogin(env.app, PASSWORD);
    const res = await adminReq({ new_password: 'resetpass456' });
    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(true);
  });

  it('old sessions revoked after reset', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    await adminReq({ new_password: 'resetpass456' });

    // Old token should be invalid
    const syncRes = await req(env.app, 'POST', '/change-password', {
      current_password: 'resetpass456',
      new_password: 'anotherpass',
    }, { Authorization: `Bearer ${token}` });
    expect(syncRes.status).toBe(401);
  });

  it('old password fails, new password works', async () => {
    await setupAndLogin(env.app, PASSWORD);
    await adminReq({ new_password: 'resetpass456' });

    const oldRes = await req(env.app, 'POST', '/login', { password: PASSWORD });
    expect(oldRes.status).toBe(401);

    const newRes = await req(env.app, 'POST', '/login', { password: 'resetpass456' });
    expect(newRes.status).toBe(200);
  });

  it('invalid admin token returns 401', async () => {
    await setupAndLogin(env.app, PASSWORD);
    const res = await adminReq({ new_password: 'resetpass456' }, 'invalid-token-value');
    expect(res.status).toBe(401);
  });

  it('missing admin token returns 401', async () => {
    await setupAndLogin(env.app, PASSWORD);
    const res = await req(env.app, 'POST', '/admin/reset-password', {
      new_password: 'resetpass456',
    });
    expect(res.status).toBe(401);
  });

  it('password too short returns 422', async () => {
    await setupAndLogin(env.app, PASSWORD);
    const res = await adminReq({ new_password: 'short' });
    expect(res.status).toBe(422);
  });

  it('missing new_password returns 400', async () => {
    await setupAndLogin(env.app, PASSWORD);
    const res = await adminReq({});
    expect(res.status).toBe(400);
  });

  it('rate limiting (4th attempt returns 429)', async () => {
    await setupAndLogin(env.app, PASSWORD);
    clearRateLimitStore();

    for (let i = 0; i < 3; i++) {
      await adminReq({ new_password: 'resetpass456' }, 'bad-token');
    }

    const res = await adminReq({ new_password: 'resetpass456' });
    expect(res.status).toBe(429);
  });
});
