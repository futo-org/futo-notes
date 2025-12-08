/**
 * Search index types and persistence for semantic search.
 */

import { Directory, File, Paths } from "expo-file-system";

const INDEX_DIR = ".search-index";
const INDEX_FILE = "index.json";
// Version 2: Note IDs are now filenames (without extension), not derived from content
const CURRENT_VERSION = 2;

export interface IndexedChunk {
  noteId: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface NoteIndexEntry {
  noteId: string;
  modificationTime: number;
  chunks: IndexedChunk[];
}

export interface SearchIndex {
  version: number;
  model: string;
  notes: Record<string, NoteIndexEntry>;
}

/**
 * Get or create the search index directory.
 */
export function getIndexDirectory(): Directory {
  const indexDir = new Directory(Paths.document, INDEX_DIR);
  if (!indexDir.exists) {
    indexDir.create();
  }
  return indexDir;
}

/**
 * Create an empty search index.
 */
export function createEmptyIndex(model: string): SearchIndex {
  return {
    version: CURRENT_VERSION,
    model,
    notes: {},
  };
}

/**
 * Load the search index from disk.
 * Returns null if index doesn't exist or is invalid.
 */
export async function loadIndex(): Promise<SearchIndex | null> {
  try {
    const indexDir = getIndexDirectory();
    const indexFile = new File(indexDir, INDEX_FILE);

    if (!indexFile.exists) {
      return null;
    }

    const content = await indexFile.text();
    const index = JSON.parse(content) as SearchIndex;

    // Validate schema version
    if (index.version !== CURRENT_VERSION) {
      console.log(
        `Index version mismatch (got ${index.version}, expected ${CURRENT_VERSION}), will rebuild`
      );
      return null;
    }

    return index;
  } catch (error) {
    console.error("Failed to load search index:", error);
    return null;
  }
}

/**
 * Save the search index to disk.
 */
export async function saveIndex(index: SearchIndex): Promise<void> {
  try {
    const indexDir = getIndexDirectory();
    const indexFile = new File(indexDir, INDEX_FILE);
    await indexFile.write(JSON.stringify(index));
  } catch (error) {
    console.error("Failed to save search index:", error);
    throw error;
  }
}

/**
 * Remove a note from the index.
 */
export function removeNoteFromIndex(
  index: SearchIndex,
  noteId: string
): SearchIndex {
  const { [noteId]: _, ...remainingNotes } = index.notes;
  return {
    ...index,
    notes: remainingNotes,
  };
}

/**
 * Add or update a note in the index.
 */
export function updateNoteInIndex(
  index: SearchIndex,
  entry: NoteIndexEntry
): SearchIndex {
  return {
    ...index,
    notes: {
      ...index.notes,
      [entry.noteId]: entry,
    },
  };
}
