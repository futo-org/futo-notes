import { useCallback } from "react";
import MiniSearch from "minisearch";
import type { NoteDocument } from "./notesLoader";
import { useNotesStore } from "./notesStore";

export interface SearchResult {
  noteId: string;
  score: number;
  matchedChunks: {
    text: string;
    score: number;
  }[];
}

export interface UseSearchReturn {
  search: (query: string) => SearchResult[];
}

/**
 * Search hook that uses a pre-built, persisted MiniSearch index.
 * The index is loaded from Zustand store (set during app initialization).
 */
export function useSearch(): UseSearchReturn {
  const searchIndex = useNotesStore((state) => state.searchIndex);

  const search = useCallback(
    (query: string): SearchResult[] => {
      if (!query.trim() || !searchIndex) {
        return [];
      }

      try {
        const searchResults = searchIndex.search(query).slice(0, 50);

        const results: SearchResult[] = searchResults.map((result) => {
          const content = (result.content as string) || "";
          const queryLower = query.toLowerCase();
          const lines = content.split("\n");

          let bestLine = "";
          for (const line of lines) {
            if (line.toLowerCase().includes(queryLower)) {
              bestLine = line.slice(0, 200);
              break;
            }
          }

          if (!bestLine) {
            bestLine =
              lines.find((l) => l.trim().length > 0)?.slice(0, 200) || "";
          }

          return {
            noteId: result.noteId as string,
            score: result.score,
            matchedChunks: bestLine
              ? [{ text: bestLine, score: result.score }]
              : [],
          };
        });

        return results;
      } catch (error) {
        console.error("Search failed:", error);
        return [];
      }
    },
    [searchIndex],
  );

  return { search };
}
