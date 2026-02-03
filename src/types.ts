export interface NotePreview {
  id: string;
  title: string;
  preview: string;
  modificationTime: number;
}

export interface NoteDocument {
  id: string;
  noteId: string;
  content: string;
}

export interface AppState {
  notes: NotePreview[];
  searchQuery: string;
  currentRoute: string;
  routeParams: Record<string, string>;
}
