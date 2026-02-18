import { describe, it, expect } from 'vitest';
import { contentHash } from '../../src/sync/hash.js';

describe('contentHash', () => {
  it('produces a 64-char hex string', () => {
    const hash = contentHash('hello');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(contentHash('test content')).toBe(contentHash('test content'));
  });

  it('handles empty string', () => {
    const hash = contentHash('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles UTF-8 content', () => {
    const hash = contentHash('日本語テスト 🎉');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(contentHash('日本語テスト 🎉'));
  });

  it('produces different hashes for different content', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
