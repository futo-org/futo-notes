import MiniSearch from 'minisearch';

export interface NoteDocument {
  id: string;
  noteId: string;
  content: string;
}

const MINISEARCH_OPTIONS = {
  fields: ['noteId', 'content'],
  storeFields: ['noteId', 'content'],
  searchOptions: {
    boost: { noteId: 2 },
    fuzzy: 0.2,
    prefix: true
  }
};

let searchIndex: MiniSearch<NoteDocument> | null = null;

export function initSearchIndex(): void {
  searchIndex = new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);
}

export function addToSearchIndex(doc: NoteDocument): void {
  if (!searchIndex) {
    searchIndex = new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);
  }
  try {
    searchIndex.discard(doc.id);
  } catch {
    // Entry didn't exist
  }
  searchIndex.add(doc);
}

export function removeFromSearchIndex(id: string): void {
  if (!searchIndex) return;
  try {
    searchIndex.discard(id);
  } catch {
    // Entry didn't exist
  }
}

export function searchNotes(query: string): string[] {
  if (!searchIndex || !query.trim()) return [];
  const results = searchIndex.search(query);
  return results.map(r => r.noteId);
}

export function clearSearchIndex(): void {
  searchIndex = new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);
}
