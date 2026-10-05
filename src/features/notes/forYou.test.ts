import { describe, it, expect } from 'vitest';
import type { NotePreview } from '$shared/types/note';
import { getForYouNotes } from './forYou';

function makeNote(id: string, modificationTime: number): NotePreview {
  return { id, title: id, preview: `preview of ${id}`, modificationTime, tags: [] };
}

describe('getForYouNotes', () => {
  it('returns nothing when the engine reports no recent notes', () => {
    expect(getForYouNotes([], [makeNote('a', 1)])).toEqual([]);
  });

  it('follows the engine order, not the cache order', () => {
    const notes = [makeNote('alphabetical', 1), makeNote('recent', 100)];
    expect(getForYouNotes(['recent', 'alphabetical'], notes).map((note) => note.id)).toEqual([
      'recent',
      'alphabetical',
    ]);
  });

  it('skips an id the cache has not caught up with', () => {
    const notes = [makeNote('known', 1)];
    expect(getForYouNotes(['missing', 'known'], notes).map((note) => note.id)).toEqual(['known']);
  });
});
