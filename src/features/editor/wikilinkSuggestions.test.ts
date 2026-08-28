import { describe, expect, it } from 'vitest';

import { buildWikilinkIndex } from '$shared/note/wikilinks';
import type { NotePreview } from '$shared/types/note';
import {
  wikilinkCandidates,
  wikilinkQueryIn,
  WIKILINK_SUGGESTION_LIMIT,
} from './wikilinkSuggestions';

function note(id: string): NotePreview {
  return { id, title: id, preview: '', modificationTime: 0, tags: [] };
}

const NOTES = [
  note('Projects/Roadmap'),
  note('Archive/2024/Roadmap'),
  note('grocery list'),
  note('work/notes/ideas'),
];
const index = buildWikilinkIndex(NOTES.map((n) => n.id));

describe('wikilinkQueryIn', () => {
  it('opens on a bare `[[` with an empty query', () => {
    expect(wikilinkQueryIn('some text [[')).toEqual({ from: 10, query: '' });
  });

  it('carries everything typed after the brackets', () => {
    expect(wikilinkQueryIn('[[road')).toEqual({ from: 0, query: 'road' });
  });

  it('is not open before the second bracket', () => {
    expect(wikilinkQueryIn('text [')).toBeNull();
  });

  it('does not reopen on a link that is already closed', () => {
    expect(wikilinkQueryIn('[[a]] and more')).toBeNull();
  });

  it('tracks the LAST open `[[` on the line', () => {
    // A completed link earlier must not capture the query.
    expect(wikilinkQueryIn('[[a]] and [[ro')).toEqual({ from: 10, query: 'ro' });
  });

  it('stays closed once the run has a closing bracket', () => {
    expect(wikilinkQueryIn('[[a]')).toBeNull();
  });
});

describe('wikilinkCandidates', () => {
  it('offers the whole note list for an empty query', () => {
    expect(wikilinkCandidates('', NOTES, index).map((c) => c.id)).toEqual(NOTES.map((n) => n.id));
  });

  it('matches anywhere in the id, case-insensitively', () => {
    expect(wikilinkCandidates('roadmap', NOTES, index).map((c) => c.id)).toEqual([
      'Projects/Roadmap',
      'Archive/2024/Roadmap',
    ]);
  });

  it('matches on a folder segment too', () => {
    expect(wikilinkCandidates('archive', NOTES, index).map((c) => c.id)).toEqual([
      'Archive/2024/Roadmap',
    ]);
  });

  it('labels a row with the shortest unique suffix and subtitles the full path', () => {
    expect(wikilinkCandidates('ideas', NOTES, index)).toEqual([
      { id: 'work/notes/ideas', label: 'ideas', detail: 'work/notes/ideas' },
    ]);
  });

  it('leaves out the subtitle when the label already IS the id', () => {
    expect(wikilinkCandidates('grocery', NOTES, index)).toEqual([
      { id: 'grocery list', label: 'grocery list' },
    ]);
  });

  it('inserts the FULL path, never the shortened label', () => {
    // The label is display; `id` is what lands between the brackets, so a
    // shortened rendering can never write an ambiguous target into the file.
    expect(wikilinkCandidates('roadmap', NOTES, index)[0].id).toBe('Projects/Roadmap');
  });

  it('caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) => note(`note-${i}`));
    const manyIndex = buildWikilinkIndex(many.map((n) => n.id));
    expect(wikilinkCandidates('note', many, manyIndex)).toHaveLength(WIKILINK_SUGGESTION_LIMIT);
  });

  it('offers nothing when the query matches nothing', () => {
    expect(wikilinkCandidates('zzz', NOTES, index)).toEqual([]);
  });

  it('treats a whitespace-only query as empty', () => {
    expect(wikilinkCandidates('  ', NOTES, index)).toHaveLength(NOTES.length);
  });
});
