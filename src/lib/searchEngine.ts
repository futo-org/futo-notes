// Thin TS shim over the Rust `futo-notes-search` engine (Tantivy BM25 + SPLADE)
// exposed by the Tauri `search_*` commands. This coexists with the MiniSearch
// keyword index in `searchIndex.ts`: callers prefer the Rust engine when it is
// available and has results, and fall back to MiniSearch otherwise (parity
// window — see docs/migration/splade-integration-plan.md). MiniSearch is NOT
// removed.
//
// The engine reconciles BM25 fast at boot (so keyword search is live almost
// immediately) and backfills SPLADE in the background; queries fuse BM25 ⊕
// SPLADE via RRF once SPLADE is ready (`source` flips "bm25" → "hybrid").

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';

/** Mirrors the Rust `futo_notes_search::SearchHit` (serde camelCase). */
export interface EngineSearchHit {
  noteId: string;
  score: number;
  /** "bm25" until SPLADE is ready, then "hybrid". */
  source: string;
}

/** Mirrors the Rust `futo_notes_search::SearchStatus`. */
export interface EngineSearchStatus {
  keyword: { ready: boolean };
  splade: {
    ready: boolean;
    indexed: number;
    total: number;
    compiling: boolean;
    fallbackReason: string | null;
  };
}

/** Whether the Rust search command surface is reachable (Tauri only). */
export function isEngineAvailable(): boolean {
  return isTauri;
}

/**
 * Run a hybrid query against the Rust engine. Returns `null` (rather than
 * throwing) when the engine isn't reachable or hasn't initialized, so callers
 * can cleanly fall back to MiniSearch.
 */
export async function engineQuery(
  query: string,
  limit?: number,
): Promise<EngineSearchHit[] | null> {
  if (!isTauri || !query.trim()) return null;
  try {
    return await invoke<EngineSearchHit[]>('search_query', { query, limit });
  } catch (e) {
    console.warn('search_query failed, falling back to MiniSearch:', e);
    return null;
  }
}

/** Current indexing status, or `null` if the engine isn't reachable. */
export async function engineStatus(): Promise<EngineSearchStatus | null> {
  if (!isTauri) return null;
  try {
    return await invoke<EngineSearchStatus>('search_status');
  } catch {
    return null;
  }
}

/** Force a full corpus rescan (re-encodes every note). Settings / tests only. */
export async function engineRebuild(): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke('search_rebuild');
  } catch (e) {
    console.warn('search_rebuild failed:', e);
  }
}

/**
 * Incremental index update for a single note, mirrored from the `fs:change`
 * watcher event. Cheap + debounced inside the engine — safe to call on every
 * edit (unlike {@link engineRebuild}).
 */
export async function engineNotify(
  kind: 'add' | 'change' | 'unlink' | 'rename',
  relPath: string,
  from?: string,
): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke('search_notify', { kind, relPath, from });
  } catch (e) {
    console.warn('search_notify failed:', e);
  }
}
