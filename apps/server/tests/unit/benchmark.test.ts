import { describe, it, expect } from 'vitest';
import { selectModel } from '../../src/search/benchmark.js';

describe('selectModel', () => {
  it('selects 8b for very fast hardware (<10ms)', () => {
    const model = selectModel(5);
    expect(model).toBeDefined();
    expect(model!.id).toBe('qwen3-embedding-8b');
  });

  it('selects 4b for fast hardware (<30ms)', () => {
    const model = selectModel(15);
    expect(model).toBeDefined();
    expect(model!.id).toBe('qwen3-embedding-4b');
  });

  it('selects 0.6b for moderate hardware (<100ms)', () => {
    const model = selectModel(50);
    expect(model).toBeDefined();
    expect(model!.id).toBe('qwen3-embedding-0.6b');
  });

  it('selects bge-small for slower hardware (<500ms)', () => {
    const model = selectModel(200);
    expect(model).toBeDefined();
    expect(model!.id).toBe('bge-small-en-v1.5');
  });

  it('returns null for very slow hardware (>=500ms)', () => {
    expect(selectModel(500)).toBeNull();
    expect(selectModel(2000)).toBeNull();
  });

  it('handles exact threshold boundaries', () => {
    // At exact boundary, should fall to next tier
    expect(selectModel(10)!.id).toBe('qwen3-embedding-4b');
    expect(selectModel(30)!.id).toBe('qwen3-embedding-0.6b');
    expect(selectModel(100)!.id).toBe('bge-small-en-v1.5');
  });
});
