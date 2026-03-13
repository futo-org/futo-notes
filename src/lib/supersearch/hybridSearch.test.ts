import { describe, it, expect } from 'vitest';
import { hybridSearch } from './hybridSearch';
import type { SearchResultItem, NotePreview } from '../../types';
import type { VectorSearchResult } from './vectorSearch';

function makeNote(id: string): NotePreview {
  return { id, title: id, preview: `preview of ${id}`, modificationTime: Date.now(), tags: [] };
}

function makeKeywordResult(id: string, snippet?: string): SearchResultItem {
  return {
    note: makeNote(id),
    snippet: snippet ? [{ text: snippet, highlight: false }] : null,
  };
}

function makeVectorResult(uuid: string, score: number): VectorSearchResult {
  return { uuid, chunkText: `chunk from ${uuid}`, startOffset: 0, endOffset: 100, score };
}

describe('hybridSearch', () => {
  it('returns keyword-only results when no vector results', () => {
    const keyword = [makeKeywordResult('note1'), makeKeywordResult('note2')];
    const noteCache = new Map<string, NotePreview>();
    noteCache.set('note1', makeNote('note1'));
    noteCache.set('note2', makeNote('note2'));

    const results = hybridSearch(keyword, [], noteCache);
    expect(results.length).toBe(2);
    expect(results[0].note.id).toBe('note1');
    expect(results[1].note.id).toBe('note2');
  });

  it('merges overlapping results with higher combined score', () => {
    const keyword = [makeKeywordResult('note1'), makeKeywordResult('note2')];
    // note1 appears in both keyword and vector results — should rank highest
    const vector = [makeVectorResult('note1', 0.9), makeVectorResult('note3', 0.8)];
    const noteCache = new Map<string, NotePreview>();
    noteCache.set('note1', makeNote('note1'));
    noteCache.set('note2', makeNote('note2'));
    noteCache.set('note3', makeNote('note3'));

    const results = hybridSearch(keyword, vector, noteCache);
    // note1 should be first since it appears in both lists
    expect(results[0].note.id).toBe('note1');
    expect(results.length).toBe(3);
  });

  it('preserves keyword snippets for overlapping results', () => {
    const keyword = [makeKeywordResult('note1', 'keyword match snippet')];
    const vector = [makeVectorResult('note1', 0.9)];
    const noteCache = new Map<string, NotePreview>();
    noteCache.set('note1', makeNote('note1'));

    const results = hybridSearch(keyword, vector, noteCache);
    expect(results[0].snippet).toEqual([{ text: 'keyword match snippet', highlight: false }]);
  });

  it('creates snippet from vector chunk for vector-only results', () => {
    const keyword: SearchResultItem[] = [];
    const vector = [makeVectorResult('note1', 0.9)];
    const noteCache = new Map<string, NotePreview>();
    noteCache.set('note1', makeNote('note1'));

    const results = hybridSearch(keyword, vector, noteCache);
    expect(results.length).toBe(1);
    expect(results[0].snippet![0].text).toContain('chunk from note1');
  });

  it('returns empty array when both inputs are empty', () => {
    const noteCache = new Map<string, NotePreview>();
    const results = hybridSearch([], [], noteCache);
    expect(results).toEqual([]);
  });

  it('RRF scoring: rank 0 in both lists scores higher than rank 0 in one', () => {
    const keyword = [makeKeywordResult('note1'), makeKeywordResult('note2')];
    const vector = [makeVectorResult('note1', 0.95), makeVectorResult('note2', 0.5)];
    const noteCache = new Map<string, NotePreview>();
    noteCache.set('note1', makeNote('note1'));
    noteCache.set('note2', makeNote('note2'));

    const results = hybridSearch(keyword, vector, noteCache);
    // note1 is rank 0 in keyword and rank 0 in vector → highest RRF
    // note2 is rank 1 in keyword and rank 1 in vector
    expect(results[0].note.id).toBe('note1');
    expect(results[1].note.id).toBe('note2');
  });
});
