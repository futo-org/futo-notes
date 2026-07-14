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
    const notes = [makeNote('a', 1), makeNote('b', 2)];
    const result = getForYouNotes(notes, 3);
    expect(result).toHaveLength(2);
  });

  it('returns at most `limit` notes', () => {
    const notes = [makeNote('a', 1), makeNote('b', 2), makeNote('c', 3), makeNote('d', 4)];
    const result = getForYouNotes(notes, 2);
    expect(result).toHaveLength(2);
  });

  it('ranks most recently modified notes first', () => {
    const notes = [makeNote('old', 1), makeNote('recent', 100), makeNote('mid', 50)];
    const result = getForYouNotes(notes, 3);
    expect(result.map((n) => n.id)).toEqual(['recent', 'mid', 'old']);
  });

  it('defaults to limit of 3', () => {
    const notes = [
      makeNote('a', 1),
      makeNote('b', 2),
      makeNote('c', 3),
      makeNote('d', 4),
      makeNote('e', 5),
    ];
    const result = getForYouNotes(notes);
    expect(result).toHaveLength(3);
  });
});
