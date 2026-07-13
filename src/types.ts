export interface NotePreview {
  id: string;
  title: string;
  preview: string;
  modificationTime: number;
  tags: string[];
}

export interface SearchResultItem {
  note: NotePreview;
  snippet: string | null;
}

export interface AppState {
  notes: NotePreview[];
  searchQuery: string;
  currentRoute: string;
  routeParams: Record<string, string>;
}
