import { create } from "zustand";

export interface NotePreview {
  id: string;
  title: string;
  preview: string;
  modificationTime: number;
}

interface NotesStore {
  notes: NotePreview[];
  setNotes: (notes: NotePreview[]) => void;
  updateNote: (oldId: string, newId: string, content: string) => void;
}

/**
 * Extract preview text from note content (first ~100 chars after title)
 */
function getPreviewText(content: string): string {
  const lines = content.split("\n");
  // Skip the first line (title) and get remaining content
  const restContent = lines.slice(1).join(" ").trim();
  if (restContent.length > 100) {
    return restContent.slice(0, 100) + "...";
  }
  return restContent || "No additional content";
}

export const useNotesStore = create<NotesStore>((set) => ({
  notes: [],

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
}));
