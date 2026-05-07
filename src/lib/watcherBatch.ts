/**
 * Watcher event batching and deduplication.
 *
 * The OS file watcher fires events for every file touched — including files the
 * app just wrote itself (local saves, sync writes, renames). This module
 * manages the queue, debounce timer, concurrency guard, and sync-active
 * buffering so the component only receives events that actually need UI work.
 *
 * Flow:
 *  1. `enqueue(event)` — pushes event into the appropriate queue
 *     - If sync writes are active, events go into a pending buffer that drains
 *       after sync completes
 *     - Otherwise events go into the handler queue and the debounce timer starts
 *  2. After the 50ms debounce, `processWatcherBatch` deduplicates and dispatches:
 *     - >10 events -> `onBulkRefresh(events)` for a single bulk reload
 *     - <=10 events -> individual `onEvent(event)` callbacks
 *  3. `drainPostSync()` — called when sync finishes; filters out events caused
 *     by our own sync writes, then processes the remainder as a bulk refresh
 */

import type { FileChangeEvent } from './platform/types';
import type { WriteSuppressor } from './writeSuppression';

export interface WatcherBatchOptions {
  /** Called for each event in a small batch (<=10 events). */
  onEvent: (event: FileChangeEvent) => Promise<void>;
  /**
   * Called for bulk batches (>10 events) and post-sync drain.
   * Receives the deduped events so the component can check if the active note
   * was affected.
   */
  onBulkRefresh: (events: FileChangeEvent[]) => Promise<void>;
  /** Write suppressor for filtering self-caused events in post-sync drain. */
  suppressor: WriteSuppressor;
  /**
   * Look up the last-known content hash for a filename (from V2 sync state).
   * Used by the rename heuristic to match unlink+add pairs by hash.
   * If not provided, rename detection is disabled.
   */
  getFileHash?: (filename: string) => string | undefined;
  /**
   * Compute the content hash of a file. Used to verify that a newly created
   * file matches a recently deleted file (rename detection).
   */
  computeFileHash?: (filename: string) => Promise<string | undefined>;
}

export interface WatcherBatch {
  enqueue(event: FileChangeEvent): void;
  drainPostSync(): void;
  setSyncActive(active: boolean): void;
  destroy(): void;
}

const RENAME_DETECT_WINDOW_MS = 500;

export function createWatcherBatch(options: WatcherBatchOptions): WatcherBatch {
  const { onEvent, onBulkRefresh, suppressor, getFileHash, computeFileHash } = options;

  let syncActive = false;
  let pendingWatcherEvents: FileChangeEvent[] = [];
  let watcherHandlerQueue: FileChangeEvent[] = [];
  let watcherBatchTimer: number | null = null;
  let postSyncBatchTimer: number | null = null;
  let watcherHandlerInFlight = false;

  // ── Rename detection state ───────────────────────────────
  // When a .md file is unlinked, hold it briefly to see if a matching
  // add event follows (external rename). The events still enter the queue
  // as separate unlink + add — no protocol-level rename.
  const pendingDeletes: Map<string, { hash: string; timer: number }> = new Map();

  function enqueue(event: FileChangeEvent): void {
    // OS-level rename pair (from notify-debouncer-full / cookie pairing)
    // gets surfaced as an explicit `rename` event with both `from` and
    // `filename`. Decompose into unlink + add so the existing dedupe
    // and bulk-refresh pipeline downstream stays in one shape.
    if (event.type === 'rename' && event.from) {
      enqueue({ type: 'unlink', filename: event.from });
      enqueue({ type: 'add', filename: event.filename });
      return;
    }
    if (syncActive) {
      pendingWatcherEvents.push(event);
      return;
    }

    // Rename detection: hold unlink events briefly
    if (event.type === 'unlink' && event.filename.endsWith('.md') && getFileHash && computeFileHash) {
      const hash = getFileHash(event.filename);
      if (hash) {
        const timer = window.setTimeout(() => {
          // No matching add arrived — finalize as deletion
          pendingDeletes.delete(event.filename);
          pushToQueue(event);
        }, RENAME_DETECT_WINDOW_MS);
        pendingDeletes.set(event.filename, { hash, timer });
        return;
      }
    }

    // Rename detection: check add events against pending deletes
    if (event.type === 'add' && event.filename.endsWith('.md') && computeFileHash && pendingDeletes.size > 0) {
      // Check asynchronously, then enqueue both events together
      void (async () => {
        const newHash = await computeFileHash(event.filename);
        if (newHash) {
          for (const [deletedFilename, pending] of pendingDeletes) {
            if (pending.hash === newHash) {
              // Match found — cancel the delete timer and emit both events together
              clearTimeout(pending.timer);
              pendingDeletes.delete(deletedFilename);
              pushToQueue({ type: 'unlink', filename: deletedFilename });
              pushToQueue(event);
              return;
            }
          }
        }
        // No match — just enqueue the add
        pushToQueue(event);
      })();
      return;
    }

    pushToQueue(event);
  }

  function pushToQueue(event: FileChangeEvent): void {
    watcherHandlerQueue.push(event);
    if (watcherBatchTimer === null) {
      watcherBatchTimer = window.setTimeout(() => {
        watcherBatchTimer = null;
        void processWatcherBatch();
      }, 50);
    }
  }

  async function processWatcherBatch(): Promise<void> {
    if (watcherHandlerInFlight) return;
    watcherHandlerInFlight = true;
    try {
      while (watcherHandlerQueue.length > 0) {
        const batch = watcherHandlerQueue.splice(0);
        // Deduplicate: keep last event per filename
        const deduped = new Map<string, FileChangeEvent>();
        for (const ev of batch) {
          deduped.set(ev.filename, ev);
        }
        const events = [...deduped.values()];

        if (events.length > 10) {
          await onBulkRefresh(events);
        } else {
          for (const ev of events) {
            await onEvent(ev);
          }
        }
      }
    } finally {
      watcherHandlerInFlight = false;
    }
  }

  function drainPostSync(): void {
    if (postSyncBatchTimer !== null) clearTimeout(postSyncBatchTimer);
    postSyncBatchTimer = window.setTimeout(async () => {
      postSyncBatchTimer = null;
      // Filter out events caused by our own sync writes AND local writes that
      // were pending when sync started (their isRecentWrite TTL may have expired
      // during the sync round-trip, but they're still our own writes).
      const unhandled = pendingWatcherEvents.filter(ev =>
        !suppressor.isRecentSyncWrite(ev.filename) && !suppressor.isPreSyncWrite(ev.filename),
      );
      pendingWatcherEvents = [];
      suppressor.clearPreSyncWrites();
      if (unhandled.length > 0) {
        await onBulkRefresh(unhandled);
      }
    }, 500);
  }

  function setSyncActive(active: boolean): void {
    syncActive = active;
    if (active) {
      suppressor.capturePreSyncWrites();
    }
  }

  function destroy(): void {
    if (watcherBatchTimer !== null) {
      clearTimeout(watcherBatchTimer);
      watcherBatchTimer = null;
    }
    if (postSyncBatchTimer !== null) {
      clearTimeout(postSyncBatchTimer);
      postSyncBatchTimer = null;
    }
    for (const pending of pendingDeletes.values()) {
      clearTimeout(pending.timer);
    }
    pendingDeletes.clear();
    pendingWatcherEvents = [];
    watcherHandlerQueue = [];
  }

  return { enqueue, drainPostSync, setSyncActive, destroy };
}
