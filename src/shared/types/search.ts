import type { NotePreview } from './note';

export interface SearchResultItem {
  note: NotePreview;
  snippet: string | null;
}
