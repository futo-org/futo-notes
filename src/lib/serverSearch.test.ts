import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotePreview } from '../types';
import {
  fetchServerSearchResults,
  fuseConnectedSearchResults,
  hasSemanticServerResults,
  mapServerResults,
  type ServerSearchResponse,
} from './serverSearch';

const notes: NotePreview[] = [
  {
    id: 'shopping',
    title: 'shopping',
    preview: 'Buy milk and eggs',
    modificationTime: 1,
    tags: [],
  },
  {
    id: 'packing',
    title: 'packing',
    preview: 'Passport and charger before the flight',
    modificationTime: 2,
    tags: [],
  },
];

describe('serverSearch helpers', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches server search results with bearer auth', async () => {
    const response: ServerSearchResponse = {
      results: [],
      timing: { keyword_ms: 1, vector_ms: 2, total_ms: 3 },
      vector_enabled: true,
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));

    const data = await fetchServerSearchResults('http://server.test', 'token-123', 'roadmap');

    expect(data).toEqual(response);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://server.test/search?q=roadmap&limit=20');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-123',
    });
  });

  it('maps server filenames back to local notes', () => {
    const response: ServerSearchResponse = {
      results: [
        {
          filename: 'shopping.md',
          snippet: 'milk and eggs',
          score: 1,
          source: 'keyword',
        },
      ],
      timing: { keyword_ms: 1, vector_ms: 0, total_ms: 1 },
      vector_enabled: false,
    };

    const mapped = mapServerResults(response, notes);
    expect(mapped.results).toHaveLength(1);
    expect(mapped.results[0].note.id).toBe('shopping');
    expect(mapped.semanticResults).toHaveLength(0);
  });

  it('drops unmapped server results and keeps local fallback active', () => {
    const response: ServerSearchResponse = {
      results: [
        {
          filename: 'missing.md',
          snippet: 'orphaned result',
          score: 1,
          source: 'keyword',
        },
      ],
      timing: { keyword_ms: 1, vector_ms: 0, total_ms: 1 },
      vector_enabled: false,
    };

    const mapped = mapServerResults(response, notes);
    expect(mapped.results).toHaveLength(0);
    expect(hasSemanticServerResults(mapped)).toBe(false);
  });

  it('keeps only semantic-capable hits for the connected semantic leg', () => {
    const response: ServerSearchResponse = {
      results: [
        {
          filename: 'shopping.md',
          snippet: 'milk and eggs',
          score: 1,
          source: 'keyword',
        },
        {
          filename: 'packing.md',
          snippet: 'passport and charger',
          score: 0.8,
          source: 'vector',
        },
      ],
      timing: { keyword_ms: 1, vector_ms: 4, total_ms: 5 },
      vector_enabled: true,
    };

    const mapped = mapServerResults(response, notes);
    expect(mapped.results).toHaveLength(2);
    expect(mapped.semanticResults).toHaveLength(1);
    expect(mapped.semanticResults[0].note.id).toBe('packing');
    expect(hasSemanticServerResults(mapped)).toBe(true);
  });

  it('fuses local keyword and semantic server results into one hybrid list', () => {
    const keywordResults = [
      {
        note: notes[0],
        snippet: [{ text: 'Buy milk and eggs', highlight: false }],
        source: 'keyword' as const,
      },
    ];
    const serverResults = mapServerResults(
      {
        results: [
          {
            filename: 'shopping.md',
            snippet: 'milk and eggs',
            score: 1,
            source: 'both',
          },
          {
            filename: 'packing.md',
            snippet: 'passport and charger',
            score: 0.9,
            source: 'vector',
          },
        ],
        timing: { keyword_ms: 1, vector_ms: 4, total_ms: 5 },
        vector_enabled: true,
      },
      notes,
    );

    const fused = fuseConnectedSearchResults(keywordResults, serverResults);
    expect(fused.map((item) => [item.note.id, item.source])).toEqual([
      ['shopping', 'both'],
      ['packing', 'vector'],
    ]);
  });

  it('falls back to keyword-only results when semantic hits are absent', () => {
    const keywordResults = [
      {
        note: notes[0],
        snippet: [{ text: 'Buy milk and eggs', highlight: false }],
        source: 'keyword' as const,
      },
    ];

    const fused = fuseConnectedSearchResults(keywordResults, null);
    expect(fused).toEqual(keywordResults);
  });
});
