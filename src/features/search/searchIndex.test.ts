import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('$lib/platform');

import { testFS } from '$lib/platform';
import {
  initSearchIndex,
  addToSearchIndex,
  searchNotes,
  extractHeadings,
  extractSnippet,
  buildHighlightedSegments,
  getStoredBody,
  loadPersistedIndex,
  persistIndex,
  flushPersistIndex,
  getMtimeMap,
} from './searchIndex';

beforeEach(() => {
  testFS._reset();
  initSearchIndex();
});

afterAll(() => {
  testFS._cleanup();
});

describe('extractHeadings', () => {
  it('extracts h1-h6 headings', () => {
    const content = '# Title\nSome text\n## Subtitle\nMore text\n### Deep heading';
    expect(extractHeadings(content)).toBe('Title Subtitle Deep heading');
  });

  it('returns empty string for no headings', () => {
    expect(extractHeadings('Just plain text\nNo headings here')).toBe('');
  });

  it('handles headings with inline formatting', () => {
    const content = '# **Bold Title**\n## *Italic Sub*';
    expect(extractHeadings(content)).toBe('**Bold Title** *Italic Sub*');
  });

  it('does not match lines without space after #', () => {
    expect(extractHeadings('#NoSpace\n# Has Space')).toBe('Has Space');
  });
});

describe('buildHighlightedSegments', () => {
  it('highlights a single term', () => {
    const segments = buildHighlightedSegments('hello world foo', ['world']);
    expect(segments).toEqual([
      { text: 'hello ', highlight: false },
      { text: 'world', highlight: true },
      { text: ' foo', highlight: false },
    ]);
  });

  it('highlights multiple terms', () => {
    const segments = buildHighlightedSegments('the quick brown fox', ['quick', 'fox']);
    expect(segments).toEqual([
      { text: 'the ', highlight: false },
      { text: 'quick', highlight: true },
      { text: ' brown ', highlight: false },
      { text: 'fox', highlight: true },
    ]);
  });

  it('merges overlapping ranges', () => {
    // "foobar" matches both "foo" and "foob" — they overlap
    const segments = buildHighlightedSegments('xfoobarx', ['foo', 'foob']);
    expect(segments).toEqual([
      { text: 'x', highlight: false },
      { text: 'foob', highlight: true },
      { text: 'arx', highlight: false },
    ]);
  });

  it('returns single unhighlighted segment for no matches', () => {
    const segments = buildHighlightedSegments('hello world', ['xyz']);
    expect(segments).toEqual([{ text: 'hello world', highlight: false }]);
  });

  it('handles case-insensitive matching', () => {
    const segments = buildHighlightedSegments('Hello World', ['hello']);
    expect(segments).toEqual([
      { text: 'Hello', highlight: true },
      { text: ' World', highlight: false },
    ]);
  });

  it('handles no terms', () => {
    const segments = buildHighlightedSegments('hello', []);
    expect(segments).toEqual([{ text: 'hello', highlight: false }]);
  });
});

describe('extractSnippet', () => {
  it('centers snippet on first match in body', () => {
    const longBody = 'A'.repeat(200) + ' specialword ' + 'B'.repeat(200);
    addToSearchIndex({ id: 'test', title: 'Test', body: longBody, mtime: Date.now() });

    const hits = searchNotes('specialword');
    expect(hits).toHaveLength(1);

    const snippet = extractSnippet(hits[0]);
    const fullText = snippet.map((s) => s.text).join('');
    expect(fullText).toContain('specialword');
    expect(fullText).toContain('...');
  });

  it('falls back to first 120 chars when match is title-only', () => {
    const body = 'This body has no matching terms at all. Just some random content here.';
    addToSearchIndex({ id: 'titlematch', title: 'titlematch', body, mtime: Date.now() });

    const hits = searchNotes('titlematch');
    expect(hits).toHaveLength(1);

    const snippet = extractSnippet(hits[0]);
    const fullText = snippet.map((s) => s.text).join('');
    expect(fullText).toContain('This body has no matching');
  });

  it('handles match at start of body', () => {
    const body = 'keyword at the very start of this document';
    addToSearchIndex({ id: 'start', title: 'start', body, mtime: Date.now() });

    const hits = searchNotes('keyword');
    expect(hits).toHaveLength(1);

    const snippet = extractSnippet(hits[0]);
    const fullText = snippet.map((s) => s.text).join('');
    expect(fullText.startsWith('...')).toBe(false);
    expect(fullText).toContain('keyword');
  });

  it('handles short body', () => {
    addToSearchIndex({ id: 'short', title: 'short', body: 'hi there', mtime: Date.now() });

    const hits = searchNotes('hi');
    expect(hits).toHaveLength(1);

    const snippet = extractSnippet(hits[0]);
    const fullText = snippet.map((s) => s.text).join('');
    expect(fullText).toContain('hi');
    expect(fullText).not.toContain('...');
  });
});

describe('Unicode snippet boundaries', () => {
  it('handles emoji in highlighted text', () => {
    const segments = buildHighlightedSegments('I love pizza 🍕 and pasta', ['pizza']);
    expect(segments).toEqual([
      { text: 'I love ', highlight: false },
      { text: 'pizza', highlight: true },
      { text: ' 🍕 and pasta', highlight: false },
    ]);
  });

  it('handles CJK text in highlighted segments', () => {
    const segments = buildHighlightedSegments('日本語のテスト文章', ['テスト']);
    expect(segments).toEqual([
      { text: '日本語の', highlight: false },
      { text: 'テスト', highlight: true },
      { text: '文章', highlight: false },
    ]);
  });

  it('handles multi-term highlighting across Unicode text', () => {
    const segments = buildHighlightedSegments('hello 世界 and goodbye 世界', ['hello', '世界']);
    expect(segments).toEqual([
      { text: 'hello', highlight: true },
      { text: ' ', highlight: false },
      { text: '世界', highlight: true },
      { text: ' and goodbye ', highlight: false },
      { text: '世界', highlight: true },
    ]);
  });

  it('handles combining characters', () => {
    // e + combining acute accent = é
    const text = 'caf\u0065\u0301 au lait';
    const segments = buildHighlightedSegments(text, ['lait']);
    expect(segments).toEqual([
      { text: 'caf\u0065\u0301 au ', highlight: false },
      { text: 'lait', highlight: true },
    ]);
  });
});

describe('empty search results', () => {
  it('returns empty array for empty query', () => {
    addToSearchIndex({ id: 'note1', title: 'note1', body: 'some content', mtime: Date.now() });
    expect(searchNotes('')).toEqual([]);
  });

  it('returns empty array for whitespace-only query', () => {
    addToSearchIndex({ id: 'note1', title: 'note1', body: 'some content', mtime: Date.now() });
    expect(searchNotes('   ')).toEqual([]);
  });

  it('returns empty array when no documents match', () => {
    addToSearchIndex({ id: 'note1', title: 'note1', body: 'hello world', mtime: Date.now() });
    expect(searchNotes('zzzznonexistent')).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips: save and load index', async () => {
    addToSearchIndex({ id: 'note1', title: 'note1', body: 'persisted content hello', mtime: 1000 });
    addToSearchIndex({ id: 'note2', title: 'note2', body: 'other persisted data', mtime: 2000 });

    persistIndex();
    await flushPersistIndex();

    // Reinitialize and load from persisted data
    initSearchIndex();
    expect(searchNotes('persisted')).toHaveLength(0); // fresh index is empty

    const loaded = await loadPersistedIndex();
    expect(loaded).toBe(true);

    const results = searchNotes('persisted');
    expect(results).toHaveLength(2);

    // mtime map should be restored
    const mtimes = getMtimeMap();
    expect(mtimes['note1']).toBe(1000);
    expect(mtimes['note2']).toBe(2000);
  });

  it('returns false on missing persisted file', async () => {
    const loaded = await loadPersistedIndex();
    expect(loaded).toBe(false);
  });

  it('returns false on version mismatch', async () => {
    // Write a file with wrong version
    await testFS.writeAppData(
      '.search-index-v1.json',
      JSON.stringify({ version: 999, indexJSON: '{}', mtimeMap: {} }),
    );

    const loaded = await loadPersistedIndex();
    expect(loaded).toBe(false);
  });

  it('stored body is accessible after load', async () => {
    addToSearchIndex({
      id: 'bodytest',
      title: 'bodytest',
      body: 'the stored body content',
      mtime: 1000,
    });
    persistIndex();
    await flushPersistIndex();

    initSearchIndex();
    await loadPersistedIndex();

    const body = getStoredBody('bodytest');
    expect(body).toBe('the stored body content');
  });
});
