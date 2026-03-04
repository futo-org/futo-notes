import { describe, it, expect } from 'vitest';
import { MODEL_REGISTRY, getModelDef, DEFAULT_MODEL_ID } from '../../src/search/modelRegistry.js';

describe('MODEL_REGISTRY', () => {
  it('contains only qwen3-embedding-0.6b', () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(ids).toEqual(['qwen3-embedding-0.6b']);
  });

  it('qwen3-embedding-0.6b uses 1024d output', () => {
    const model = getModelDef('qwen3-embedding-0.6b');
    expect(model).toBeDefined();
    expect(model!.dims).toBe(1024);
    expect(model!.nativeDims).toBe(1024);
  });

  it('all models have valid dims <= nativeDims', () => {
    for (const model of MODEL_REGISTRY) {
      expect(model.dims).toBeLessThanOrEqual(model.nativeDims);
      expect(model.dims).toBeGreaterThan(0);
    }
  });
});

describe('getModelDef', () => {
  it('returns model for valid ID', () => {
    const model = getModelDef('qwen3-embedding-0.6b');
    expect(model).toBeDefined();
    expect(model!.id).toBe('qwen3-embedding-0.6b');
  });

  it('returns undefined for unknown ID', () => {
    expect(getModelDef('nonexistent-model')).toBeUndefined();
  });
});

describe('DEFAULT_MODEL_ID', () => {
  it('points to a valid registry entry', () => {
    const model = getModelDef(DEFAULT_MODEL_ID);
    expect(model).toBeDefined();
  });
});
