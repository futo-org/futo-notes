import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, authReq, req, type TestEnv } from '../helpers/setup.js';
import { hashToken } from '../../src/auth/token.js';

describe('POST /revoke', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('revokes current session', async () => {
    const res = await authReq(env.app, 'POST', '/revoke', token, { mode: 'current' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(1);

    // Token should no longer work
    const syncRes = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(syncRes.status).toBe(401);
  });

  it('revokes all sessions', async () => {
    // Create a second session
    const loginRes = await req(env.app, 'POST', '/login', { password: 'testpassword123' });
    const data2 = await loginRes.json();
    const token2 = data2.token;

    const res = await authReq(env.app, 'POST', '/revoke', token, { mode: 'all' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(2);

    // Both tokens should fail
    const r1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(r1.status).toBe(401);

    const r2 = await authReq(env.app, 'POST', '/sync', token2, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(r2.status).toBe(401);
  });

  it('revokes specific sessions by token hash', async () => {
    // Create a second session
    const loginRes = await req(env.app, 'POST', '/login', { password: 'testpassword123' });
    const data2 = await loginRes.json();
    const token2 = data2.token;
    const token2Hash = hashToken(token2);

    // Revoke token2 specifically, using token1 for auth
    const res = await authReq(env.app, 'POST', '/revoke', token, {
      mode: 'specific',
      token_hashes: [token2Hash],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(1);

    // token1 should still work
    const r1 = await authReq(env.app, 'POST', '/sync', token, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(r1.status).toBe(200);

    // token2 should be revoked
    const r2 = await authReq(env.app, 'POST', '/sync', token2, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });
    expect(r2.status).toBe(401);
  });

  it('rejects invalid mode (400)', async () => {
    const res = await authReq(env.app, 'POST', '/revoke', token, { mode: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('rejects specific mode without token_hashes (400)', async () => {
    const res = await authReq(env.app, 'POST', '/revoke', token, { mode: 'specific' });
    expect(res.status).toBe(400);
  });

  it('rejects unauthorized request (401)', async () => {
    const res = await req(env.app, 'POST', '/revoke', { mode: 'current' });
    expect(res.status).toBe(401);
  });
});
