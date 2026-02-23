export interface NotePreview {
  id: string;
  title: string;
  preview: string;
  modificationTime: number;
}

export interface SnippetSegment {
  text: string;
  highlight: boolean;
}

export interface SearchResultItem {
  note: NotePreview;
  snippet: SnippetSegment[] | null;
}

export interface AppState {
  notes: NotePreview[];
  searchQuery: string;
  currentRoute: string;
  routeParams: Record<string, string>;
}
