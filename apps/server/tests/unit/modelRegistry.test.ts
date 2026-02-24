import { describe, it, expect } from 'vitest';
import { MODEL_REGISTRY, getModelDef, BENCHMARK_MODEL_ID } from '../../src/search/modelRegistry.js';

describe('MODEL_REGISTRY', () => {
  it('contains expected models', () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(ids).toContain('bge-small-en-v1.5');
    expect(ids).toContain('qwen3-embedding-0.6b');
    expect(ids).toContain('qwen3-embedding-4b');
    expect(ids).toContain('qwen3-embedding-8b');
  });

  it('all models have valid dims <= nativeDims', () => {
    for (const model of MODEL_REGISTRY) {
      expect(model.dims).toBeLessThanOrEqual(model.nativeDims);
      expect(model.dims).toBeGreaterThan(0);
    }
  });

  it('all Qwen3 models use 1024d output', () => {
    const qwenModels = MODEL_REGISTRY.filter((m) => m.id.startsWith('qwen3'));
    expect(qwenModels.length).toBe(3);
    for (const m of qwenModels) {
      expect(m.dims).toBe(1024);
    }
  });

  it('bge-small uses native 384d', () => {
    const bge = getModelDef('bge-small-en-v1.5');
    expect(bge).toBeDefined();
    expect(bge!.dims).toBe(384);
    expect(bge!.nativeDims).toBe(384);
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

describe('BENCHMARK_MODEL_ID', () => {
  it('points to a valid registry entry', () => {
    const model = getModelDef(BENCHMARK_MODEL_ID);
    expect(model).toBeDefined();
  });

  it('is the smallest model', () => {
    const model = getModelDef(BENCHMARK_MODEL_ID)!;
    for (const m of MODEL_REGISTRY) {
      expect(model.sizeBytes).toBeLessThanOrEqual(m.sizeBytes);
    }
  });
});
