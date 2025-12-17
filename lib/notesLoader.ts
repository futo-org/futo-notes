import { Directory, File, Paths } from "expo-file-system";
import MiniSearch from "minisearch";
import { storage, STORAGE_KEYS, CURRENT_CACHE_VERSION } from "./storage";
import { NotePreview } from "./notesStore";

const NOTES_DIR = "notes";

export interface NoteDocument {
  id: string;
  noteId: string;
  content: string;
}

interface IndexMetadata {
  [noteId: string]: number;
}

interface FileInfo {
  noteId: string;
  modificationTime: number;
  file: File;
}

interface LoadResult {
  previews: NotePreview[];
  searchIndex: MiniSearch<NoteDocument>;
}

export const MINISEARCH_OPTIONS = {
  fields: ["noteId", "content"],
  storeFields: ["noteId", "content"],
  searchOptions: {
    boost: { noteId: 2 },
    fuzzy: 0.2,
    prefix: true,
  },
};

function getNotesDirectory(): Directory {
  const notesDir = new Directory(Paths.document, NOTES_DIR);
  if (!notesDir.exists) {
    notesDir.create();
  }
  return notesDir;
}

function getPreviewText(content: string): string {
  const preview = content.replace(/\s+/g, " ").trim();
  return preview.length > 100
    ? preview.slice(0, 100) + "..."
    : preview || "No content";
}

function listNoteFiles(): FileInfo[] {
  const notesDir = getNotesDirectory();
  if (!notesDir.exists) return [];

  const contents = notesDir.list();
  const files: FileInfo[] = [];

  for (const item of contents) {
    if (!(item instanceof File) || !item.uri.endsWith(".md")) continue;

    const filename = item.uri.split("/").pop() || "";
    const noteId = decodeURIComponent(filename.replace(/\.md$/, ""));

    files.push({
      noteId,
      modificationTime: item.modificationTime ?? 0,
      file: item,
    });
  }

  return files;
}

function loadCachedData(): {
  index: MiniSearch<NoteDocument> | null;
  metadata: IndexMetadata;
  previews: NotePreview[];
} {
  try {
    // Check cache version - invalidate if outdated
    const cachedVersion = storage.getNumber(STORAGE_KEYS.CACHE_VERSION);
    if (cachedVersion !== CURRENT_CACHE_VERSION) {
      return { index: null, metadata: {}, previews: [] };
    }

    const indexJson = storage.getString(STORAGE_KEYS.SEARCH_INDEX);
    const metadataJson = storage.getString(STORAGE_KEYS.INDEX_METADATA);
    const previewsJson = storage.getString(STORAGE_KEYS.NOTE_PREVIEWS);

    if (!indexJson) {
      return { index: null, metadata: {}, previews: [] };
    }

    const index = MiniSearch.loadJSON<NoteDocument>(
      indexJson,
      MINISEARCH_OPTIONS,
    );
    const metadata: IndexMetadata = metadataJson
      ? JSON.parse(metadataJson)
      : {};
    const previews: NotePreview[] = previewsJson
      ? JSON.parse(previewsJson)
      : [];

    return { index, metadata, previews };
  } catch (error) {
    console.error("Failed to load cached data:", error);
    return { index: null, metadata: {}, previews: [] };
  }
}

function persistData(
  index: MiniSearch<NoteDocument>,
  metadata: IndexMetadata,
  previews: NotePreview[],
): void {
  try {
    storage.set(STORAGE_KEYS.SEARCH_INDEX, JSON.stringify(index));
    storage.set(STORAGE_KEYS.INDEX_METADATA, JSON.stringify(metadata));
    storage.set(STORAGE_KEYS.NOTE_PREVIEWS, JSON.stringify(previews));
    storage.set(STORAGE_KEYS.CACHE_VERSION, CURRENT_CACHE_VERSION);
  } catch (error) {
    console.error("Failed to persist data:", error);
  }
}

function computeDiff(
  cachedMetadata: IndexMetadata,
  filesystemFiles: FileInfo[],
): {
  added: FileInfo[];
  modified: FileInfo[];
  deleted: string[];
} {
  const filesystemMap = new Map(filesystemFiles.map((f) => [f.noteId, f]));
  const cachedIds = new Set(Object.keys(cachedMetadata));

  const added: FileInfo[] = [];
  const modified: FileInfo[] = [];
  const deleted: string[] = [];

  for (const fileInfo of filesystemFiles) {
    const cachedTime = cachedMetadata[fileInfo.noteId];
    if (cachedTime === undefined) {
      added.push(fileInfo);
    } else if (cachedTime !== fileInfo.modificationTime) {
      modified.push(fileInfo);
    }
  }

  for (const cachedId of cachedIds) {
    if (!filesystemMap.has(cachedId)) {
      deleted.push(cachedId);
    }
  }

  return { added, modified, deleted };
}

/**
 * Main loading function - single entry point for app startup.
 * Loads from cache if valid, otherwise rebuilds from filesystem.
 */
export async function loadNotesWithIndex(): Promise<LoadResult> {
  const filesystemFiles = listNoteFiles();
  const {
    index: cachedIndex,
    metadata: cachedMetadata,
    previews: cachedPreviews,
  } = loadCachedData();

  const diff = computeDiff(cachedMetadata, filesystemFiles);
  const hasChanges =
    diff.added.length > 0 ||
    diff.modified.length > 0 ||
    diff.deleted.length > 0;

  // Fast path: cache is valid, return immediately
  if (cachedIndex && !hasChanges && cachedPreviews.length > 0) {
    return { previews: cachedPreviews, searchIndex: cachedIndex };
  }

  // Need to rebuild or update
  let searchIndex: MiniSearch<NoteDocument>;
  const newMetadata: IndexMetadata = {};
  const previewsMap = new Map<string, NotePreview>();

  if (!cachedIndex) {
    // Full rebuild
    searchIndex = new MiniSearch<NoteDocument>(MINISEARCH_OPTIONS);

    for (const fileInfo of filesystemFiles) {
      const content = await fileInfo.file.text();

      searchIndex.add({
        id: fileInfo.noteId,
        noteId: fileInfo.noteId,
        content,
      });

      newMetadata[fileInfo.noteId] = fileInfo.modificationTime;
      previewsMap.set(fileInfo.noteId, {
        id: fileInfo.noteId,
        title: fileInfo.noteId,
        preview: getPreviewText(content),
        modificationTime: fileInfo.modificationTime,
      });
    }
  } else {
    // Incremental update
    searchIndex = cachedIndex;
    Object.assign(newMetadata, cachedMetadata);

    // Start with cached previews
    for (const preview of cachedPreviews) {
      previewsMap.set(preview.id, preview);
    }

    // Handle deleted notes
    for (const noteId of diff.deleted) {
      try {
        searchIndex.discard(noteId);
      } catch {
        // Note wasn't in index
      }
      delete newMetadata[noteId];
      previewsMap.delete(noteId);
    }

    // Handle modified notes
    for (const fileInfo of diff.modified) {
      try {
        searchIndex.discard(fileInfo.noteId);
      } catch {
        // Note wasn't in index
      }

      const content = await fileInfo.file.text();

      searchIndex.add({
        id: fileInfo.noteId,
        noteId: fileInfo.noteId,
        content,
      });

      newMetadata[fileInfo.noteId] = fileInfo.modificationTime;
      previewsMap.set(fileInfo.noteId, {
        id: fileInfo.noteId,
        title: fileInfo.noteId,
        preview: getPreviewText(content),
        modificationTime: fileInfo.modificationTime,
      });
    }

    // Handle added notes
    for (const fileInfo of diff.added) {
      const content = await fileInfo.file.text();

      searchIndex.add({
        id: fileInfo.noteId,
        noteId: fileInfo.noteId,
        content,
      });

      newMetadata[fileInfo.noteId] = fileInfo.modificationTime;
      previewsMap.set(fileInfo.noteId, {
        id: fileInfo.noteId,
        title: fileInfo.noteId,
        preview: getPreviewText(content),
        modificationTime: fileInfo.modificationTime,
      });
    }
  }

  // Convert map to sorted array
  const previews = Array.from(previewsMap.values()).sort(
    (a, b) => b.modificationTime - a.modificationTime,
  );

  // Persist updated data
  persistData(searchIndex, newMetadata, previews);

  return { previews, searchIndex };
}

/**
 * Update index for a single note (called after save).
 */
export function updateNoteInIndex(
  index: MiniSearch<NoteDocument>,
  noteId: string,
  content: string,
  modificationTime: number,
  previews: NotePreview[],
): NotePreview[] {
  // Remove old entry if exists
  try {
    index.discard(noteId);
  } catch {
    // Note didn't exist in index
  }

  // Add new entry
  try {
    index.add({
      id: noteId,
      noteId,
      content,
    });
  } catch (error) {
    console.error(`Failed to add note "${noteId}" to index:`, error);
    // Continue anyway - the file is saved, we just can't search it until next reload
  }

  // Update previews
  const filteredPreviews = previews.filter((p) => p.id !== noteId);
  const newPreview: NotePreview = {
    id: noteId,
    title: noteId,
    preview: getPreviewText(content),
    modificationTime,
  };
  const updatedPreviews = [newPreview, ...filteredPreviews];

  // Update metadata and persist
  const metadataJson = storage.getString(STORAGE_KEYS.INDEX_METADATA);
  const metadata: IndexMetadata = metadataJson ? JSON.parse(metadataJson) : {};
  metadata[noteId] = modificationTime;

  persistData(index, metadata, updatedPreviews);

  return updatedPreviews;
}

/**
 * Handle note rename in index (old note removed, new note added).
 */
export function renameNoteInIndex(
  index: MiniSearch<NoteDocument>,
  oldNoteId: string,
  newNoteId: string,
  content: string,
  modificationTime: number,
  previews: NotePreview[],
): NotePreview[] {
  // Remove old entry
  try {
    index.discard(oldNoteId);
  } catch {
    // Old note didn't exist in index
  }

  // Remove new entry if it exists (overwriting)
  try {
    index.discard(newNoteId);
  } catch {
    // New note didn't exist in index
  }

  // Add new entry
  try {
    index.add({
      id: newNoteId,
      noteId: newNoteId,
      content,
    });
  } catch (error) {
    console.error(
      `Failed to add renamed note "${newNoteId}" to index:`,
      error,
    );
  }

  // Update previews
  const filteredPreviews = previews.filter(
    (p) => p.id !== oldNoteId && p.id !== newNoteId,
  );
  const newPreview: NotePreview = {
    id: newNoteId,
    title: newNoteId,
    preview: getPreviewText(content),
    modificationTime,
  };
  const updatedPreviews = [newPreview, ...filteredPreviews];

  // Update metadata
  const metadataJson = storage.getString(STORAGE_KEYS.INDEX_METADATA);
  const metadata: IndexMetadata = metadataJson ? JSON.parse(metadataJson) : {};
  delete metadata[oldNoteId];
  metadata[newNoteId] = modificationTime;

  persistData(index, metadata, updatedPreviews);

  return updatedPreviews;
}

/**
 * Remove note from index (called after delete).
 */
export function removeNoteFromIndex(
  index: MiniSearch<NoteDocument>,
  noteId: string,
  previews: NotePreview[],
): NotePreview[] {
  try {
    index.discard(noteId);
  } catch {
    // Note didn't exist in index
  }

  const updatedPreviews = previews.filter((p) => p.id !== noteId);

  // Update metadata
  const metadataJson = storage.getString(STORAGE_KEYS.INDEX_METADATA);
  const metadata: IndexMetadata = metadataJson ? JSON.parse(metadataJson) : {};
  delete metadata[noteId];

  persistData(index, metadata, updatedPreviews);

  return updatedPreviews;
}
