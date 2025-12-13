import { createMMKV } from "react-native-mmkv";

export const storage = createMMKV({ id: "futo-notes" });

export const STORAGE_KEYS = {
  SEARCH_INDEX: "search-index",
  INDEX_METADATA: "index-metadata",
  NOTE_PREVIEWS: "note-previews",
} as const;
