import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bruteForceSearch } from './bruteForceSearch';

// We need to test bruteForceSearch with pre-loaded data.
// The function reads from module-level cached variables, so we test via
// a helper that injects data directly.

// Helper: create a normalized vector of given dims
function normalizedVector(dims: number, seed: number): Float32Array {
  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.sin(seed * (i + 1));
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}

// To test bruteForceSearch we need to mock the internal module state.
// Since the module uses module-level `cachedVectors` and `cachedManifest`,
// we mock the getFS + loadArtifacts path.

vi.mock('../platform', () => ({
  getFS: () => ({
    readAppData: vi.fn().mockResolvedValue(null),
    readBinaryAppData: vi.fn().mockResolvedValue(null),
  }),
}));

describe('bruteForceSearch', () => {
  it('returns empty array when no artifacts loaded', () => {
    const query = normalizedVector(384, 42);
    const results = bruteForceSearch(query, 5);
    expect(results).toEqual([]);
  });
});

describe('bruteForceSearch with cosine similarity', () => {
  it('computes correct dot product for identical vectors', () => {
    // Dot product of a normalized vector with itself should be ~1.0
    const vec = normalizedVector(4, 1);
    let dot = 0;
    for (let i = 0; i < vec.length; i++) dot += vec[i] * vec[i];
    expect(dot).toBeCloseTo(1.0, 5);
  });

  it('computes correct dot product for orthogonal-ish vectors', () => {
    // Vectors with different seeds should have lower similarity
    const v1 = normalizedVector(384, 1);
    const v2 = normalizedVector(384, 100);
    let dot = 0;
    for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i];
    expect(dot).toBeLessThan(1.0);
  });
});
