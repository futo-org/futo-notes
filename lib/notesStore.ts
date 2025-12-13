import { create } from "zustand";
import MiniSearch from "minisearch";
import type { NoteDocument } from "./notesLoader";

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
  searchIndex: MiniSearch<NoteDocument> | null;
  searchQuery: string;
  searchResults: SearchResult[] | null;
  setNotes: (notes: NotePreview[]) => void;
  setSearchIndex: (index: MiniSearch<NoteDocument>) => void;
  deleteNote: (id: string) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: SearchResult[] | null) => void;
}

export const useNotesStore = create<NotesStore>((set) => ({
  notes: [],
  searchIndex: null,
  searchQuery: "",
  searchResults: null,

  setNotes: (notes) => set({ notes }),

  setSearchIndex: (index) => set({ searchIndex: index }),

  deleteNote: (id) =>
    set((state) => ({
      notes: state.notes.filter((n) => n.id !== id),
    })),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchResults: (results) => set({ searchResults: results }),
}));
