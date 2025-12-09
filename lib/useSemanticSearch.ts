/**
 * Simple keyword search hook.
 * Replaces the Cactus-based semantic search with basic text matching.
 */

import { useState, useCallback, useRef } from "react";
import { Directory, File, Paths } from "expo-file-system";

const NOTES_DIR = "notes";

export interface SearchResult {
  noteId: string;
  score: number;
  matchedChunks: {
    text: string;
    score: number;
  }[];
}

export interface UseSemanticSearchReturn {
  isSearching: boolean;
  search: (query: string) => Promise<SearchResult[]>;
}

function getNotesDirectory(): Directory {
  return new Directory(Paths.document, NOTES_DIR);
}

/**
 * Tokenize text into lowercase words.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 0);
}

/**
 * Calculate keyword match score between query and text.
 * Returns a score from 0 to 1 based on what fraction of query terms appear.
 */
function keywordScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const textLower = text.toLowerCase();
  let matches = 0;

  for (const token of queryTokens) {
    if (textLower.includes(token)) {
      matches++;
    }
  }

  return matches / queryTokens.length;
}

/**
 * Simple keyword search hook.
 */
export function useSemanticSearch(): UseSemanticSearchReturn {
  const [isSearching, setIsSearching] = useState(false);
  const notesContentRef = useRef<Map<string, string>>(new Map());

  /**
   * Search notes using keyword matching.
   */
  const search = useCallback(async (query: string): Promise<SearchResult[]> => {
    if (!query.trim()) {
      return [];
    }

    setIsSearching(true);

    try {
      const notesDir = getNotesDirectory();
      if (!notesDir.exists) {
        return [];
      }

      const contents = notesDir.list();
      const results: SearchResult[] = [];

      for (const item of contents) {
        if (!(item instanceof File) || !item.uri.endsWith(".md")) {
          continue;
        }

        const filename = item.uri.split("/").pop() || "";
        const noteId = decodeURIComponent(filename.replace(/\.md$/, ""));

        // Read note content
        let content: string;
        if (notesContentRef.current.has(noteId)) {
          content = notesContentRef.current.get(noteId)!;
        } else {
          content = await item.text();
          notesContentRef.current.set(noteId, content);
        }

        // Calculate score
        const score = keywordScore(query, content);

        if (score > 0) {
          // Find matching snippet
          const queryTerms = tokenize(query);
          const lines = content.split("\n");
          let bestLine = "";
          let bestLineScore = 0;

          for (const line of lines) {
            const lineScore = keywordScore(query, line);
            if (lineScore > bestLineScore) {
              bestLineScore = lineScore;
              bestLine = line.slice(0, 200);
            }
          }

          results.push({
            noteId,
            score,
            matchedChunks: bestLine
              ? [{ text: bestLine, score: bestLineScore }]
              : [],
          });
        }
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

      return results;
    } catch (error) {
      console.error("Search failed:", error);
      return [];
    } finally {
      setIsSearching(false);
    }
  }, []);

  return {
    isSearching,
    search,
  };
}
