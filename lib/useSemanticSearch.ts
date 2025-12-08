/**
 * React hook for semantic search using Cactus embeddings.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { InteractionManager } from "react-native";
import { useCactusLM } from "cactus-react-native";
import { Directory, File, Paths } from "expo-file-system";

import { chunkByParagraphs } from "./chunking";
import {
  SearchIndex,
  NoteIndexEntry,
  IndexedChunk,
  loadIndex,
  saveIndex,
  createEmptyIndex,
  removeNoteFromIndex as removeFromIndex,
  updateNoteInIndex,
} from "./searchIndex";
import { cosineSimilarity, keywordScore } from "./vectorMath";
import { NotePreview, useNotesStore } from "./notesStore";

const EMBEDDING_MODEL = "qwen3-0.6-embed";
const EMBEDDING_CONTEXT_SIZE = 512; // Smaller context for embedding, reduces memory

// Qwen embeddings have a baseline similarity around 0.50-0.51 for unrelated text
// We normalize scores relative to this baseline
const SEMANTIC_BASELINE = 0.50;
const SIMILARITY_THRESHOLD = 0.35; // After normalization: requires ~0.57 raw semantic score
const KEYWORD_WEIGHT = 0.4;
const SEMANTIC_WEIGHT = 0.6;
const NOTES_DIR = "notes";

/**
 * Mutex-style lock to ensure only one embedding operation runs at a time.
 * CactusLM cannot handle concurrent embedding calls.
 */
class EmbedLock {
  private locked = false;
  private waitQueue: (() => void)[] = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    // Wait for lock to be released
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next?.();
    } else {
      this.locked = false;
    }
  }
}

// Global lock to serialize all embedding operations
const embedLock = new EmbedLock();

export interface SearchResult {
  noteId: string;
  score: number;
  matchedChunks: {
    text: string;
    score: number;
  }[];
}

export interface UseSemanticSearchReturn {
  // State
  isIndexing: boolean;
  isSearching: boolean;
  indexProgress: { current: number; total: number } | null;
  isModelReady: boolean;
  isModelDownloading: boolean;
  modelDownloadProgress: number;

  // Actions
  search: (query: string) => Promise<SearchResult[]>;
  indexNote: (noteId: string, content: string) => Promise<void>;
  removeNoteFromIndex: (noteId: string) => Promise<void>;
  syncIndex: (notes: NotePreview[]) => Promise<void>;
}

function getNotesDirectory(): Directory {
  return new Directory(Paths.document, NOTES_DIR);
}

export function useSemanticSearch(): UseSemanticSearchReturn {
  const [isIndexing, setIsIndexing] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [modelReady, setModelReady] = useState(false);

  const indexRef = useRef<SearchIndex | null>(null);
  const abortRef = useRef(false);
  const syncInProgressRef = useRef(false);

  const setIndexingState = useNotesStore((state) => state.setIndexingState);

  const cactusLM = useCactusLM({
    model: EMBEDDING_MODEL,
    contextSize: EMBEDDING_CONTEXT_SIZE,
  });

  // Initialize model and load index on mount
  useEffect(() => {
    let cancelled = false;

    const initModel = async () => {
      try {
        // Wait for isDownloaded check
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (cancelled) return;

        if (!cactusLM.isDownloaded && !cactusLM.isDownloading) {
          console.log("Downloading embedding model...");
          try {
            await cactusLM.download();
          } catch (downloadError) {
            // Cactus sometimes throws spurious timeout errors during download
            // Check if model actually downloaded despite the error
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (!cactusLM.isDownloaded) {
              throw downloadError;
            }
            console.log("Download completed despite error");
          }
          console.log("Embedding model downloaded");
        }

        if (cancelled) return;

        // Only initialize if not already initializing
        if (!cactusLM.isInitializing && !cactusLM.isReady) {
          console.log("Initializing embedding model...");
          try {
            await cactusLM.init();
          } catch (initError) {
            // Check if model actually initialized despite the error
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (!cactusLM.isReady) {
              throw initError;
            }
            console.log("Init completed despite error");
          }
          console.log("Embedding model initialized");
        }

        if (cancelled) return;

        // Warmup embedding with a simple test to ensure model is fully ready
        console.log("Warming up embedding model...");
        try {
          await cactusLM.embed({ text: "test" });
          console.log("Embedding model warmup complete");
        } catch (warmupError) {
          console.warn("Warmup embedding failed, continuing anyway:", warmupError);
        }

        if (cancelled) return;

        // Load existing index
        const existingIndex = await loadIndex();
        if (existingIndex && existingIndex.model === EMBEDDING_MODEL) {
          indexRef.current = existingIndex;
          console.log(
            `Loaded search index with ${Object.keys(existingIndex.notes).length} notes`,
          );
        } else {
          indexRef.current = createEmptyIndex(EMBEDDING_MODEL);
          console.log("Created new search index");
        }

        setModelReady(true);
      } catch (error) {
        console.error("Failed to initialize semantic search:", error);
      }
    };

    initModel();

    return () => {
      cancelled = true;
      // Free model resources on unmount
      cactusLM.destroy?.();
    };
  }, []);

  /**
   * Embed text using Cactus (serialized through lock to prevent concurrent calls).
   */
  const embedText = useCallback(
    async (text: string): Promise<number[]> => {
      await embedLock.acquire();
      try {
        const result = await cactusLM.embed({ text });
        return result.embedding;
      } finally {
        embedLock.release();
      }
    },
    [cactusLM],
  );

  /**
   * Index a single note.
   */
  const indexNote = useCallback(
    async (noteId: string, content: string): Promise<void> => {
      if (!modelReady || !indexRef.current) {
        console.log("Model not ready, skipping indexNote");
        return;
      }

      try {
        console.log(`  Chunking content...`);
        let chunks = chunkByParagraphs(content);
        console.log(`  Got ${chunks.length} chunks`);

        if (chunks.length === 0) {
          // Note has no indexable content, remove from index if present
          if (indexRef.current.notes[noteId]) {
            indexRef.current = removeFromIndex(indexRef.current, noteId);
            await saveIndex(indexRef.current);
          }
          return;
        }

        // Limit chunks per note to prevent memory issues with very large notes
        const MAX_CHUNKS_PER_NOTE = 10;
        if (chunks.length > MAX_CHUNKS_PER_NOTE) {
          console.log(`  Limiting to ${MAX_CHUNKS_PER_NOTE} chunks`);
          chunks = chunks.slice(0, MAX_CHUNKS_PER_NOTE);
        }

        const indexedChunks: IndexedChunk[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          console.log(`  Embedding chunk ${i + 1}/${chunks.length} (${chunk.text.length} chars)...`);
          let embedding: number[] | null = null;

          // Retry up to 3 times with backoff
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              embedding = await embedText(chunk.text);
              break;
            } catch (error) {
              console.warn(`  Embed attempt ${attempt + 1} failed:`, error);
              if (attempt < 2) {
                // Wait before retry: 100ms, 300ms
                await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
              } else {
                console.warn(`  Failed to embed chunk ${i} after 3 attempts`);
              }
            }
          }

          if (embedding) {
            console.log(`  Chunk ${i + 1} embedded successfully`);
            indexedChunks.push({
              noteId,
              chunkIndex: i,
              text: chunk.text,
              embedding,
            });
          }

          // Small pause between chunks
          await new Promise(r => setTimeout(r, 50));
        }

        if (indexedChunks.length > 0) {
          const entry: NoteIndexEntry = {
            noteId,
            modificationTime: Date.now(),
            chunks: indexedChunks,
          };

          indexRef.current = updateNoteInIndex(indexRef.current, entry);
          await saveIndex(indexRef.current);
          console.log(
            `Indexed note "${noteId}" with ${indexedChunks.length} chunks`,
          );
        }
      } catch (error) {
        console.error(`Failed to index note "${noteId}":`, error);
      }
    },
    [modelReady, embedText],
  );

  /**
   * Remove a note from the index.
   */
  const removeNoteFromIndex = useCallback(async (noteId: string) => {
    if (!indexRef.current) return;

    if (indexRef.current.notes[noteId]) {
      indexRef.current = removeFromIndex(indexRef.current, noteId);
      await saveIndex(indexRef.current);
      console.log(`Removed note "${noteId}" from index`);
    }
  }, []);

  /**
   * Sync the index with the current notes list.
   * Re-indexes changed notes and removes deleted ones.
   */
  const syncIndex = useCallback(
    async (notes: NotePreview[]) => {
      if (!modelReady || !indexRef.current) {
        console.log("Model not ready, skipping syncIndex");
        return;
      }

      // Prevent concurrent sync operations
      if (syncInProgressRef.current) {
        console.log("Sync already in progress, skipping");
        return;
      }

      syncInProgressRef.current = true;
      abortRef.current = false;
      setIsIndexing(true);
      setIndexingState(true, null);

      try {
        const index = indexRef.current;
        const currentNoteIds = new Set(notes.map((n) => n.id));

        // Find notes that need indexing
        const needsIndexing: NotePreview[] = [];
        for (const note of notes) {
          const entry = index.notes[note.id];
          if (!entry || entry.modificationTime < note.modificationTime) {
            needsIndexing.push(note);
          }
        }

        // Remove deleted notes from index
        for (const noteId of Object.keys(index.notes)) {
          if (!currentNoteIds.has(noteId)) {
            indexRef.current = removeFromIndex(indexRef.current, noteId);
            console.log(`Removed deleted note "${noteId}" from index`);
          }
        }

        if (needsIndexing.length === 0) {
          console.log("Index is up to date");
          setIsIndexing(false);
          setIndexingState(false, null);
          syncInProgressRef.current = false;
          return;
        }

        console.log(`Need to index ${needsIndexing.length} notes`);
        setIndexProgress({ current: 0, total: needsIndexing.length });
        setIndexingState(true, { current: 0, total: needsIndexing.length });

        // Give the UI time to render before starting heavy work
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Build a map of note ID to file from the directory listing
        // Using files from .list() ensures proper initialization of File objects
        const notesDir = getNotesDirectory();
        const dirContents = notesDir.list();
        const fileMap = new Map<string, File>();
        for (const item of dirContents) {
          if (item instanceof File && item.uri.endsWith(".md")) {
            const filename = item.uri.split("/").pop() || "";
            const noteId = decodeURIComponent(filename.replace(/\.md$/, ""));
            fileMap.set(noteId, item);
          }
        }

        const BATCH_SIZE = 5; // Save index every N notes to reduce memory pressure
        const PAUSE_BETWEEN_NOTES_MS = 100; // Delay to let GC run and prevent overheating

        console.log("Starting indexing loop...");

        for (let i = 0; i < needsIndexing.length; i++) {
          if (abortRef.current) {
            console.log("Indexing aborted");
            break;
          }

          const note = needsIndexing[i];
          console.log(`Processing note ${i + 1}/${needsIndexing.length}: "${note.id}"`);

          setIndexProgress({ current: i + 1, total: needsIndexing.length });
          setIndexingState(true, { current: i + 1, total: needsIndexing.length });

          try {
            const noteFile = fileMap.get(note.id);
            if (noteFile) {
              console.log(`Reading file for "${note.id}"...`);
              const content = await noteFile.text();
              console.log(`Indexing "${note.id}" (${content.length} chars)...`);
              await indexNote(note.id, content);
              console.log(`Done indexing "${note.id}"`);
            } else {
              console.warn(`File not found for note "${note.id}"`);
            }
          } catch (error) {
            console.warn(`Failed to index note "${note.id}":`, error);
          }

          // Save index periodically to free memory from accumulated embeddings
          if ((i + 1) % BATCH_SIZE === 0 && indexRef.current) {
            await saveIndex(indexRef.current);
          }

          // Yield to UI and allow GC between notes
          await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_NOTES_MS));
        }

        // Save final state
        if (indexRef.current) {
          await saveIndex(indexRef.current);
        }

        console.log("Index sync complete");
      } catch (error) {
        console.error("Failed to sync index:", error);
      } finally {
        syncInProgressRef.current = false;
        setIsIndexing(false);
        setIndexProgress(null);
        setIndexingState(false, null);
      }
    },
    [modelReady, indexNote, setIndexingState],
  );

  /**
   * Search notes using hybrid keyword + semantic scoring.
   */
  const search = useCallback(
    async (query: string): Promise<SearchResult[]> => {
      console.log(
        `Search called: query="${query}" modelReady=${modelReady} hasIndex=${!!indexRef.current} isIndexing=${isIndexing}`,
      );
      if (!modelReady || !indexRef.current || !query.trim() || isIndexing) {
        console.log("Search early return - conditions not met");
        return [];
      }

      setIsSearching(true);

      try {
        // Embed the query for semantic search
        const queryEmbedding = await embedText(query);

        // Score all chunks with both keyword and semantic scores
        const chunkScores: {
          noteId: string;
          text: string;
          semanticScore: number;
          kwScore: number;
          hybridScore: number;
        }[] = [];

        console.log(`\n=== Search: "${query}" ===`);

        for (const entry of Object.values(indexRef.current.notes)) {
          for (const chunk of entry.chunks) {
            const rawSemanticScore = cosineSimilarity(
              queryEmbedding,
              chunk.embedding,
            );
            // Normalize semantic score relative to baseline
            // Maps baseline (0.50) -> 0, and 1.0 -> 1.0
            const semanticScore = Math.max(0, (rawSemanticScore - SEMANTIC_BASELINE) / (1 - SEMANTIC_BASELINE));
            const kwScore = keywordScore(query, chunk.text);
            const hybridScore =
              KEYWORD_WEIGHT * kwScore + SEMANTIC_WEIGHT * semanticScore;

            chunkScores.push({
              noteId: chunk.noteId,
              text: chunk.text,
              semanticScore,
              kwScore,
              hybridScore,
            });
          }
        }

        // Log top chunks by semantic score to understand what the model thinks is similar
        const topSemantic = [...chunkScores]
          .sort((a, b) => b.semanticScore - a.semanticScore)
          .slice(0, 5);
        console.log("\nTop 5 by SEMANTIC score:");
        topSemantic.forEach((c, i) => {
          console.log(
            `  ${i + 1}. sem=${c.semanticScore.toFixed(3)} [${c.noteId}] "${c.text.slice(0, 60)}..."`,
          );
        });

        // Log top chunks by keyword score
        const topKeyword = [...chunkScores]
          .filter((c) => c.kwScore > 0)
          .sort((a, b) => b.kwScore - a.kwScore)
          .slice(0, 5);
        if (topKeyword.length > 0) {
          console.log("\nTop by KEYWORD score:");
          topKeyword.forEach((c, i) => {
            console.log(
              `  ${i + 1}. kw=${c.kwScore.toFixed(2)} [${c.noteId}] "${c.text.slice(0, 60)}..."`,
            );
          });
        } else {
          console.log("\nNo keyword matches found");
        }

        // Aggregate scores per note (max hybrid score, track best kw/sem)
        const noteScoresMap = new Map<
          string,
          {
            score: number;
            bestKw: number;
            bestSem: number;
            chunks: { text: string; score: number }[];
          }
        >();

        for (const {
          noteId,
          text,
          hybridScore,
          kwScore: kw,
          semanticScore: sem,
        } of chunkScores) {
          const existing = noteScoresMap.get(noteId);
          if (existing) {
            existing.chunks.push({ text, score: hybridScore });
            if (hybridScore > existing.score) {
              existing.score = hybridScore;
              existing.bestKw = kw;
              existing.bestSem = sem;
            }
          } else {
            noteScoresMap.set(noteId, {
              score: hybridScore,
              bestKw: kw,
              bestSem: sem,
              chunks: [{ text, score: hybridScore }],
            });
          }
        }

        // Convert to results and filter/sort
        const results: SearchResult[] = [];
        const resultDetails: {
          noteId: string;
          kw: number;
          sem: number;
          hybrid: number;
        }[] = [];
        for (const [noteId, data] of noteScoresMap) {
          if (data.score >= SIMILARITY_THRESHOLD) {
            // Sort chunks by score and keep top ones
            const sortedChunks = data.chunks
              .sort((a, b) => b.score - a.score)
              .slice(0, 3);

            results.push({
              noteId,
              score: data.score,
              matchedChunks: sortedChunks,
            });
            resultDetails.push({
              noteId,
              kw: data.bestKw,
              sem: data.bestSem,
              hybrid: data.score,
            });
          }
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        resultDetails.sort((a, b) => b.hybrid - a.hybrid);

        console.log(`\n=== Results (${results.length}) ===`);
        resultDetails.forEach((r, i) => {
          console.log(
            `${i + 1}. [${r.noteId}] kw=${r.kw.toFixed(2)} sem=${r.sem.toFixed(2)} hybrid=${r.hybrid.toFixed(3)}`,
          );
        });

        return results;
      } catch (error) {
        console.error("Search failed:", error);
        return [];
      } finally {
        setIsSearching(false);
      }
    },
    [modelReady, embedText, isIndexing],
  );

  return {
    isIndexing,
    isSearching,
    indexProgress,
    isModelReady: modelReady,
    isModelDownloading: cactusLM.isDownloading,
    modelDownloadProgress: cactusLM.downloadProgress,
    search,
    indexNote,
    removeNoteFromIndex,
    syncIndex,
  };
}
