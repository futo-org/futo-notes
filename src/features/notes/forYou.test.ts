import { describe, it, expect } from 'vitest';
import type { NotePreview } from '$shared/types/note';
import { getForYouNotes } from './forYou';

function makeNote(id: string, modificationTime: number): NotePreview {
  return { id, title: id, preview: `preview of ${id}`, modificationTime, tags: [] };
}

describe('getForYouNotes', () => {
  it('returns empty array for empty notes', () => {
    expect(getForYouNotes([])).toEqual([]);
  });

  it('returns all notes when fewer than limit', () => {
    const notes = [makeNote('b', 2), makeNote('a', 1)];
    expect(getForYouNotes(notes, 3)).toHaveLength(2);
  });

  it('returns the first `limit` notes of the engine-ordered list', () => {
    const notes = [makeNote('recent', 100), makeNote('mid', 50), makeNote('old', 1)];
    expect(getForYouNotes(notes, 2).map((note) => note.id)).toEqual(['recent', 'mid']);
  });

  it('defaults to limit of 3', () => {
    const notes = [
      makeNote('e', 5),
      makeNote('d', 4),
      makeNote('c', 3),
      makeNote('b', 2),
      makeNote('a', 1),
    ];
    expect(getForYouNotes(notes)).toHaveLength(3);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(getForYouNotes([makeNote('a', 1)], 0)).toEqual([]);
  });
});
