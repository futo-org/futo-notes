import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authReq, createTestEnv, req, setupAndLogin, type TestEnv } from '../helpers/setup.js';
import { clearRateLimitStore } from '../../src/middleware/rateLimit.js';

describe('POST /change-password', () => {
  let env: TestEnv;
  const PASSWORD = 'testpassword123';

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('changes password and returns new token', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    const res = await authReq(env.app, 'POST', '/change-password', token, {
      current_password: PASSWORD,
      new_password: 'newpassword456',
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; token: string };
    expect(data.success).toBe(true);
    expect(data.token).toBeTruthy();
    expect(data.token).not.toBe(token);
  });

  it('old token is invalidated after change', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    await authReq(env.app, 'POST', '/change-password', token, {
      current_password: PASSWORD,
      new_password: 'newpassword456',
    });

    // Old token should be rejected
    const res = await authReq(env.app, 'POST', '/change-password', token, {
      current_password: 'newpassword456',
      new_password: 'anotherpass789',
    });
    expect(res.status).toBe(401);
  });

  it('new token works for authenticated requests', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    const changeRes = await authReq(env.app, 'POST', '/change-password', token, {
      current_password: PASSWORD,
      new_password: 'newpassword456',
    });
    const { token: newToken } = await changeRes.json() as { token: string };

    // New token should work
    const res = await authReq(env.app, 'POST', '/change-password', newToken, {
      current_password: 'newpassword456',
      new_password: 'yetanother789',
    });
    expect(res.status).toBe(200);
  });

  it('login with new password works, old password fails', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    await authReq(env.app, 'POST', '/change-password', token, {
      current_password: PASSWORD,
      new_password: 'newpassword456',
    });

    // Old password fails
    const oldRes = await req(env.app, 'POST', '/login', { password: PASSWORD });
    expect(oldRes.status).toBe(401);

    // New password works
    const newRes = await req(env.app, 'POST', '/login', { password: 'newpassword456' });
    expect(newRes.status).toBe(200);
  });

  it('wrong current_password returns 401', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    const res = await authReq(env.app, 'POST', '/change-password', token, {
      current_password: 'wrongpassword',
      new_password: 'newpassword456',
    });
    expect(res.status).toBe(401);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('Invalid current password');
  });

  it('new password too short returns 422', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    const res = await authReq(env.app, 'POST', '/change-password', token, {
      current_password: PASSWORD,
      new_password: 'short',
    });
    expect(res.status).toBe(422);
  });

  it('missing fields return 400', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);

    const res1 = await authReq(env.app, 'POST', '/change-password', token, {
      new_password: 'newpassword456',
    });
    expect(res1.status).toBe(400);

    const res2 = await authReq(env.app, 'POST', '/change-password', token, {
      current_password: PASSWORD,
    });
    expect(res2.status).toBe(400);
  });

  it('unauthenticated returns 401', async () => {
    await setupAndLogin(env.app, PASSWORD);
    const res = await req(env.app, 'POST', '/change-password', {
      current_password: PASSWORD,
      new_password: 'newpassword456',
    });
    expect(res.status).toBe(401);
  });

  it('rate limiting (6th attempt returns 429)', async () => {
    const token = await setupAndLogin(env.app, PASSWORD);
    clearRateLimitStore();

    for (let i = 0; i < 5; i++) {
      await authReq(env.app, 'POST', '/change-password', token, {
        current_password: 'wrongpassword',
        new_password: 'newpassword456',
      });
    }

    const res = await authReq(env.app, 'POST', '/change-password', token, {
      current_password: 'wrongpassword',
      new_password: 'newpassword456',
    });
    expect(res.status).toBe(429);
  });
});
