export interface NotePreview {
  id: string;
  title: string;
  preview: string;
  modificationTime: number;
  tags: string[];
}

export interface SnippetSegment {
  text: string;
  highlight: boolean;
}

export interface SearchResultItem {
  note: NotePreview;
  snippet: SnippetSegment[] | null;
  source?: 'keyword' | 'vector' | 'both';
}

export interface AppState {
  notes: NotePreview[];
  searchQuery: string;
  currentRoute: string;
  routeParams: Record<string, string>;
}
