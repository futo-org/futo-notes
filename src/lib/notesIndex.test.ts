import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('$lib/platform');

import { testFS } from '$lib/platform';
import {
  makePreview,
  buildIndexedNote,
  scanNotePreviews,
  scanNotePreviewsWithBodies,
  scanNotes,
  convertTxtToMd,
} from './notesIndex';

beforeEach(() => {
  testFS._reset();
});

afterAll(() => {
  testFS._cleanup();
});

// ── makePreview ───────────────────────────────────────────────────────

describe('makePreview', () => {
  it('returns short content as-is', () => {
    expect(makePreview('hello world')).toBe('hello world');
  });

  it('replaces newlines with spaces', () => {
    expect(makePreview('line one\nline two\nline three')).toBe('line one line two line three');
  });

  it('truncates at 100 characters', () => {
    const long = 'A'.repeat(150);
    const preview = makePreview(long);
    expect(preview).toHaveLength(100);
    expect(preview).toBe('A'.repeat(100));
  });

  it('returns empty string for empty content', () => {
    expect(makePreview('')).toBe('');
  });

  it('handles content exactly 100 chars', () => {
    const exact = 'B'.repeat(100);
    expect(makePreview(exact)).toBe(exact);
  });
});

// ── buildIndexedNote ──────────────────────────────────────────────────

describe('buildIndexedNote', () => {
  it('extracts tags from content', () => {
    const note = buildIndexedNote('my note', 'Hello #world #test content', 1000);
    expect(note.tags).toContain('#world');
    expect(note.tags).toContain('#test');
  });

  it('extracts headings from content', () => {
    const note = buildIndexedNote('my note', '# Title\nBody\n## Subtitle', 1000);
    expect(note.headings).toBe('Title Subtitle');
  });

  it('sets title to id (filename IS the title)', () => {
    const note = buildIndexedNote('grocery list', 'eggs, milk', 1000);
    expect(note.title).toBe('grocery list');
  });

  it('keeps full body', () => {
    const content = 'Full body text here with lots of content';
    const note = buildIndexedNote('test', content, 1000);
    expect(note.body).toBe(content);
  });

  it('builds preview from content', () => {
    const note = buildIndexedNote('test', 'Line one\nLine two', 1000);
    expect(note.preview).toBe('Line one Line two');
  });
});

// ── scanNotePreviews ──────────────────────────────────────────────────

describe('scanNotePreviews', () => {
  it('returns empty array for empty vault', async () => {
    const previews = await scanNotePreviews(testFS);
    expect(previews).toEqual([]);
  });

  it('scans a single note', async () => {
    await testFS.writeNote('hello', '# Hello\nWorld');
    const previews = await scanNotePreviews(testFS);
    expect(previews).toHaveLength(1);
    expect(previews[0].id).toBe('hello');
    expect(previews[0].title).toBe('hello');
    expect(previews[0].preview).toBe('# Hello World');
  });

  it('returns notes sorted by mtime descending', async () => {
    await testFS.writeNote('older', 'old content', 1000000000000);
    await testFS.writeNote('newer', 'new content', 2000000000000);
    const previews = await scanNotePreviews(testFS);
    expect(previews[0].id).toBe('newer');
    expect(previews[1].id).toBe('older');
  });

  it('reuses preview cache when mtime matches', async () => {
    await testFS.writeNote('cached', 'original content', 1000000000000);

    // First scan populates cache
    const first = await scanNotePreviews(testFS);
    expect(first).toHaveLength(1);

    // Second scan should reuse cache (same mtime)
    const second = await scanNotePreviews(testFS);
    expect(second).toHaveLength(1);
    expect(second[0].preview).toBe(first[0].preview);
  });

  it('invalidates cache when mtime changes', async () => {
    await testFS.writeNote('changing', 'original content', 1000000000000);
    await scanNotePreviews(testFS);

    // Update with new mtime
    await testFS.writeNote('changing', 'updated content', 2000000000000);
    const previews = await scanNotePreviews(testFS);
    expect(previews).toHaveLength(1);
    expect(previews[0].preview).toBe('updated content');
  });

  it('extracts tags', async () => {
    await testFS.writeNote('tagged', 'Hello #world #test');
    const previews = await scanNotePreviews(testFS);
    expect(previews[0].tags).toContain('#world');
    expect(previews[0].tags).toContain('#test');
  });
});

// ── scanNotePreviewsWithBodies ────────────────────────────────────────

describe('scanNotePreviewsWithBodies', () => {
  it('returns fresh bodies for cache-miss entries', async () => {
    await testFS.writeNote('a', 'body a');
    await testFS.writeNote('b', 'body b');

    const { previews, freshBodies } = await scanNotePreviewsWithBodies(testFS);
    expect(previews).toHaveLength(2);
    expect(freshBodies.get('a')).toBe('body a');
    expect(freshBodies.get('b')).toBe('body b');
  });

  it('omits bodies for cache hits', async () => {
    await testFS.writeNote('cached', 'original', 1000000000000);

    // Populate cache
    await scanNotePreviewsWithBodies(testFS);

    // Second scan: cache hit, no body read
    const { previews, freshBodies } = await scanNotePreviewsWithBodies(testFS);
    expect(previews).toHaveLength(1);
    expect(freshBodies.has('cached')).toBe(false);
  });

  it('preserves mtime-desc sort order across hits and misses', async () => {
    // Seed cache with two notes
    await testFS.writeNote('old', 'old', 1000000000000);
    await testFS.writeNote('mid', 'mid', 2000000000000);
    await scanNotePreviewsWithBodies(testFS);

    // Add a fresh note that should sort first
    await testFS.writeNote('new', 'new', 3000000000000);

    const { previews, freshBodies } = await scanNotePreviewsWithBodies(testFS);
    expect(previews.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
    expect(freshBodies.get('new')).toBe('new');
    expect(freshBodies.has('mid')).toBe(false);
    expect(freshBodies.has('old')).toBe(false);
  });

  it('includes newly-changed notes in freshBodies', async () => {
    await testFS.writeNote('note', 'v1', 1000000000000);
    await scanNotePreviewsWithBodies(testFS);

    // Rewrite with a new mtime — should invalidate the cache entry
    await testFS.writeNote('note', 'v2', 2000000000000);
    const { freshBodies } = await scanNotePreviewsWithBodies(testFS);
    expect(freshBodies.get('note')).toBe('v2');
  });
});

// ── scanNotes (full scan) ─────────────────────────────────────────────

describe('scanNotes', () => {
  it('returns empty array for empty vault', async () => {
    const notes = await scanNotes(testFS);
    expect(notes).toEqual([]);
  });

  it('reads full bodies', async () => {
    const content = 'Full body content here for search indexing';
    await testFS.writeNote('full', content);
    const notes = await scanNotes(testFS);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(content);
  });

  it('builds indexed notes with all fields', async () => {
    await testFS.writeNote('test', '# Title\nBody #tag');
    const notes = await scanNotes(testFS);
    expect(notes[0].id).toBe('test');
    expect(notes[0].title).toBe('test');
    expect(notes[0].headings).toBe('Title');
    expect(notes[0].tags).toContain('#tag');
    expect(notes[0].body).toBe('# Title\nBody #tag');
  });
});

// ── convertTxtToMd ───────────────────────────────────────────────────

describe('convertTxtToMd', () => {
  it('renames .txt to .md when no collision', async () => {
    // Write a .txt file using writeAppData (which doesn't add .md extension)
    await testFS.writeAppData('my-note.txt', 'text content');

    await convertTxtToMd(testFS);

    // Should now have .md file
    const files = await testFS.listAppData('.');
    expect(files).toContain('my-note.md');
    expect(files).not.toContain('my-note.txt');

    // Content should be preserved
    const content = await testFS.readAppData('my-note.md');
    expect(content).toBe('text content');
  });

  it('handles collision: x.txt + x.md -> x (imported).md', async () => {
    await testFS.writeAppData('notes.txt', 'txt content');
    await testFS.writeNote('notes', 'md content'); // creates notes.md

    await convertTxtToMd(testFS);

    const files = await testFS.listAppData('.');
    expect(files).not.toContain('notes.txt');
    expect(files).toContain('notes.md');
    expect(files).toContain('notes (imported).md');

    // Original .md should be untouched
    const mdContent = await testFS.readNote('notes');
    expect(mdContent).toBe('md content');

    // Imported file should have the txt content
    const importedContent = await testFS.readAppData('notes (imported).md');
    expect(importedContent).toBe('txt content');
  });

  it('is a no-op when there are no .txt files', async () => {
    await testFS.writeNote('existing', 'content');

    await convertTxtToMd(testFS);

    const files = await testFS.listAppData('.');
    expect(files).toContain('existing.md');
    // After the migration runs once we also write a sentinel file so the
    // next session can short-circuit without another full-dir scan.
    expect(files).toContain('.txt-migration-done');
  });

  it('writes a sentinel that short-circuits subsequent calls', async () => {
    // First run: writes the sentinel
    await convertTxtToMd(testFS);
    const afterFirst = await testFS.listAppData('.');
    expect(afterFirst).toContain('.txt-migration-done');

    // Second run should see the sentinel and skip the dir scan entirely.
    // We verify by planting a .txt file *after* the sentinel is written —
    // if the second call still scans, it would migrate this file; the
    // sentinel guard must keep it untouched.
    await testFS.writeAppData('late.txt', 'late content');
    await convertTxtToMd(testFS);
    const afterSecond = await testFS.listAppData('.');
    expect(afterSecond).toContain('late.txt');
    expect(afterSecond).not.toContain('late.md');
  });
});
