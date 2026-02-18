/** Note metadata sent during sync. */
export interface NoteSyncMeta {
  uuid: string;
  filename: string;
  /** Unix ms, informational only — not used for conflict detection. */
  modified_at: number;
  /** SHA-256 hex digest of current content. */
  content_hash: string;
  /** Hash from last successful sync ("" if never synced). */
  hash_at_last_sync: string;
  /** Included only when content_hash !== hash_at_last_sync. */
  content?: string;
}
