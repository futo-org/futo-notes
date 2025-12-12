import { useState, useCallback, useRef } from "react";
import { Directory, File, Paths } from "expo-file-system";
import MiniSearch from "minisearch";

const NOTES_DIR = "notes";

export interface SearchResult {
  noteId: string;
  score: number;
  matchedChunks: {
    text: string;
    score: number;
  }[];
}

export interface UseSearchReturn {
  isSearching: boolean;
  search: (query: string) => Promise<SearchResult[]>;
}

interface NoteDocument {
  id: string;
  noteId: string;
  content: string;
}

function getNotesDirectory(): Directory {
  return new Directory(Paths.document, NOTES_DIR);
}

/**
 * Fast full-text search hook using MiniSearch.
 * Uses inverted index for instant searches with fuzzy matching.
 */
export function useSearch(): UseSearchReturn {
  const [isSearching, setIsSearching] = useState(false);
  const miniSearchRef = useRef<MiniSearch<NoteDocument> | null>(null);
  const lastIndexedRef = useRef<number>(0);

  const buildIndex = useCallback(async (): Promise<
    MiniSearch<NoteDocument>
  > => {
    const miniSearch = new MiniSearch<NoteDocument>({
      fields: ["noteId", "content"], // Fields to index
      storeFields: ["noteId", "content"], // Fields to return in results
      searchOptions: {
        boost: { noteId: 2 }, // Title matches rank higher
        fuzzy: 0.2, // Fuzzy matching tolerance
        prefix: true, // Match word prefixes (type "rec" to find "recipe")
      },
    });

    const notesDir = getNotesDirectory();
    console.log(notesDir);
    if (!notesDir.exists) {
      miniSearchRef.current = miniSearch;
      lastIndexedRef.current = Date.now();
      return miniSearch;
    }

    const contents = notesDir.list();

    for (const item of contents) {
      if (!(item instanceof File) || !item.uri.endsWith(".md")) {
        continue;
      }

      const filename = item.uri.split("/").pop() || "";
      const noteId = decodeURIComponent(filename.replace(/\.md$/, ""));
      const content = await item.text();

      miniSearch.add({
        id: noteId, // MiniSearch requires an id field
        noteId,
        content,
      });
    }

    miniSearchRef.current = miniSearch;
    lastIndexedRef.current = Date.now();
    console.log("just built db");
    console.log(miniSearch);
    return miniSearch;
  }, []);

  const search = useCallback(
    async (query: string): Promise<SearchResult[]> => {
      if (!query.trim()) {
        return [];
      }

      setIsSearching(true);

      try {
        const isStale = Date.now() - lastIndexedRef.current > 5000;
        const miniSearch =
          miniSearchRef.current && !isStale
            ? miniSearchRef.current
            : await buildIndex();

        const searchResults = miniSearch.search(query).slice(0, 50);

        const results: SearchResult[] = searchResults.map((result) => {
          // Find a matching line for the snippet
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

          // If no exact line match, use first non-empty line
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
      } finally {
        setIsSearching(false);
      }
    },
    [buildIndex]
  );

  return {
    isSearching,
    search,
  };
}
