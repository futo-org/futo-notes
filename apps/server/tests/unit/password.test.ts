import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('password hashing', () => {
  it('hash and verify roundtrip succeeds', async () => {
    const hash = await hashPassword('mypassword');
    expect(await verifyPassword(hash, 'mypassword')).toBe(true);
  });

  it('verify fails with wrong password', async () => {
    const hash = await hashPassword('correct');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces argon2id hash', async () => {
    const hash = await hashPassword('test');
    expect(hash).toContain('$argon2id$');
  });

  it('produces different hashes for same password (salted)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});
