import { createMMKV } from "react-native-mmkv";

export const storage = createMMKV({ id: "futo-notes" });

export const STORAGE_KEYS = {
  SEARCH_INDEX: "search-index",
  INDEX_METADATA: "index-metadata",
  NOTE_PREVIEWS: "note-previews",
  CACHE_VERSION: "cache-version",
} as const;

// Increment this to force cache rebuild (e.g., when fixing encoding issues)
export const CURRENT_CACHE_VERSION = 2;
