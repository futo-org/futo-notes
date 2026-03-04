import { describe, it, expect } from 'vitest';
import { DEFAULT_MODEL_ID } from '../../src/search/modelRegistry.js';

describe('DEFAULT_MODEL_ID', () => {
  it('is qwen3-embedding-0.6b', () => {
    expect(DEFAULT_MODEL_ID).toBe('qwen3-embedding-0.6b');
  });
});
