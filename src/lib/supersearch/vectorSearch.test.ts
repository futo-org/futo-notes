import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platform module
const mockPlatformName = { value: 'web' as string };
const mockFS = {
  supersearchQuery: vi.fn(),
  readAppData: vi.fn(),
  readBinaryAppData: vi.fn(),
};

vi.mock('../platform', () => ({
  get platformName() {
    return mockPlatformName.value;
  },
  getFS: () => mockFS,
}));

// Import after mocks
const { vectorSearch } = await import('./vectorSearch');

describe('vectorSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array on web platform', async () => {
    mockPlatformName.value = 'web';
    const query = new Float32Array([0.1, 0.2, 0.3]);
    const results = await vectorSearch(query, 5);
    expect(results).toEqual([]);
  });

  it('throws when native tauri query is unavailable', async () => {
    mockPlatformName.value = 'tauri';
    mockFS.supersearchQuery = undefined as unknown as typeof mockFS.supersearchQuery;
    const query = new Float32Array([0.1, 0.2, 0.3]);

    await expect(vectorSearch(query, 5)).rejects.toThrow('Native supersearch_query is unavailable on tauri platform');
  });

  it('calls IPC on tauri platform', async () => {
    mockPlatformName.value = 'tauri';
    mockFS.supersearchQuery = vi.fn();
    const query = new Float32Array([0.1, 0.2, 0.3]);
    mockFS.supersearchQuery.mockResolvedValue([
      { chunkId: 1, uuid: 'uuid1', chunkText: 'text1', startOffset: 0, endOffset: 10, score: 0.9 },
      { chunkId: 2, uuid: 'uuid2', chunkText: 'text2', startOffset: 0, endOffset: 10, score: 0.5 },
    ]);

    const results = await vectorSearch(query, 5);
    expect(mockFS.supersearchQuery).toHaveBeenCalledWith(Array.from(query), 10);
    expect(results.length).toBe(2);
  });

  it('deduplicates multiple chunks from same note', async () => {
    mockPlatformName.value = 'tauri';
    mockFS.supersearchQuery = vi.fn();
    const query = new Float32Array([0.1, 0.2, 0.3]);
    mockFS.supersearchQuery.mockResolvedValue([
      { chunkId: 1, uuid: 'uuid1', chunkText: 'chunk1', startOffset: 0, endOffset: 10, score: 0.9 },
      { chunkId: 2, uuid: 'uuid1', chunkText: 'chunk2', startOffset: 11, endOffset: 20, score: 0.7 },
      { chunkId: 3, uuid: 'uuid2', chunkText: 'chunk3', startOffset: 0, endOffset: 10, score: 0.8 },
    ]);

    const results = await vectorSearch(query, 5);
    // uuid1 appears twice, should be deduplicated keeping best score
    expect(results.length).toBe(2);
    const uuid1Result = results.find(r => r.uuid === 'uuid1')!;
    expect(uuid1Result).toBeDefined();
    expect(uuid1Result.score).toBeCloseTo(0.9, 3);
  });
});
