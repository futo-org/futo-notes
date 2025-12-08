import { create } from "zustand";

export interface NotePreview {
  id: string;
  title: string;
  preview: string;
  modificationTime: number;
}

export interface SearchResult {
  noteId: string;
  score: number;
}

interface NotesStore {
  notes: NotePreview[];
  searchQuery: string;
  searchResults: SearchResult[] | null;
  isIndexing: boolean;
  indexProgress: { current: number; total: number } | null;
  setNotes: (notes: NotePreview[]) => void;
  updateNote: (oldId: string, newId: string, content: string) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: SearchResult[] | null) => void;
  setIndexingState: (isIndexing: boolean, progress: { current: number; total: number } | null) => void;
}

/**
 * Extract preview text from note content (first ~100 chars)
 */
function getPreviewText(content: string): string {
  const preview = content.replace(/\s+/g, " ").trim();
  if (preview.length > 100) {
    return preview.slice(0, 100) + "...";
  }
  return preview || "No content";
}

export const useNotesStore = create<NotesStore>((set) => ({
  notes: [],
  searchQuery: "",
  searchResults: null,
  isIndexing: false,
  indexProgress: null,

  setNotes: (notes) => set({ notes }),

  updateNote: (oldId, newId, content) =>
    set((state) => {
      // Remove old entry (and new entry if it exists to avoid duplicates)
      const filtered = state.notes.filter(
        (n) => n.id !== oldId && n.id !== newId
      );

      // Create updated note preview
      const updatedNote: NotePreview = {
        id: newId,
        title: newId,
        preview: getPreviewText(content),
        modificationTime: Date.now(),
      };

      // Put updated note at the top
      return { notes: [updatedNote, ...filtered] };
    }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchResults: (results) => set({ searchResults: results }),

  setIndexingState: (isIndexing, progress) => set({ isIndexing, indexProgress: progress }),
}));
