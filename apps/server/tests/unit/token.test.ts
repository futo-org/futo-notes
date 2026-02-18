import { describe, it, expect } from 'vitest';
import { generateToken, hashToken } from '../../src/auth/token.js';

describe('token generation', () => {
  it('generates a 64-char hex string (32 bytes)', () => {
    const token = generateToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateToken()));
    expect(tokens.size).toBe(10);
  });
});

describe('token hashing', () => {
  it('produces a 64-char hex string', () => {
    const hash = hashToken('sometoken');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('different tokens produce different hashes', () => {
    expect(hashToken('token1')).not.toBe(hashToken('token2'));
  });
});
