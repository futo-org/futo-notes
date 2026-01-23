import { create } from "zustand";
import MiniSearch from "minisearch";
import type { NoteDocument } from "./notesLoader";

export interface NotePreview {
  id: string;
  title: string;
  preview: string;
  modificationTime: number;
}

interface NotesStore {
  notes: NotePreview[];
  searchIndex: MiniSearch<NoteDocument> | null;
  searchQuery: string;
  setNotes: (notes: NotePreview[]) => void;
  setSearchIndex: (index: MiniSearch<NoteDocument>) => void;
  setSearchQuery: (query: string) => void;
}

export const useNotesStore = create<NotesStore>((set) => ({
  notes: [],
  searchIndex: null,
  searchQuery: "",

  setNotes: (notes) => set({ notes }),

  setSearchIndex: (index) => set({ searchIndex: index }),

  setSearchQuery: (query) => set({ searchQuery: query }),
}));
