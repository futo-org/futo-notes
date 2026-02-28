import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchCapabilities } from './capabilitiesTypes';

const mockState = {
  isSupersearchReady: vi.fn<() => Promise<boolean>>(),
};

const mockEmbedder = {
  isReady: vi.fn<() => boolean>(),
};

vi.mock('./state', () => ({
  isSupersearchReady: mockState.isSupersearchReady,
}));

vi.mock('./queryEmbedder', () => ({
  isReady: mockEmbedder.isReady,
}));

const { getEffectiveSearchCapabilities } = await import('./capabilities');

function makeCaps(vectorSupported: boolean): SearchCapabilities {
  return {
    levels: [],
    model: vectorSupported ? 'model' : null,
    dims: vectorSupported ? 384 : null,
    chunk_count: vectorSupported ? 100 : 0,
    last_indexed_at: null,
    artifact_version: vectorSupported ? 'supersearch-v1' : null,
    artifact_hash: vectorSupported ? 'abc123' : null,
    query_prefix: null,
    methods: {
      keyword: { supported: true },
      vector: { supported: vectorSupported },
      hybrid: { supported: vectorSupported },
    },
  };
}

describe('getEffectiveSearchCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns vector and hybrid false when server reports vector unsupported', async () => {
    mockState.isSupersearchReady.mockResolvedValue(true);
    mockEmbedder.isReady.mockReturnValue(true);

    const result = await getEffectiveSearchCapabilities(makeCaps(false));
    expect(result).toEqual({ keyword: true, vector: false, hybrid: false });
  });

  it('returns vector and hybrid false when server supports vector but local is not ready', async () => {
    mockState.isSupersearchReady.mockResolvedValue(false);
    mockEmbedder.isReady.mockReturnValue(true);

    const result = await getEffectiveSearchCapabilities(makeCaps(true));
    expect(result).toEqual({ keyword: true, vector: false, hybrid: false });
  });

  it('returns vector and hybrid true when server supports vector and local is ready', async () => {
    mockState.isSupersearchReady.mockResolvedValue(true);
    mockEmbedder.isReady.mockReturnValue(true);

    const result = await getEffectiveSearchCapabilities(makeCaps(true));
    expect(result).toEqual({ keyword: true, vector: true, hybrid: true });
  });
});
