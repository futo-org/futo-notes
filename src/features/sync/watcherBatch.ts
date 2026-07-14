import type { FileChangeEvent } from '$lib/platform/types';
import type { WriteSuppressor } from '$lib/platform/writeSuppression';

export interface WatcherBatchOptions {
  onEvent: (event: FileChangeEvent) => Promise<void>;
  onBulkRefresh: (events: FileChangeEvent[]) => Promise<void>;
  suppressor: WriteSuppressor;
  getFileHash?: (filename: string) => string | undefined;
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

  const pendingDeletes: Map<string, { hash: string; timer: number }> = new Map();

  function enqueue(event: FileChangeEvent): void {
    if (event.type === 'rename' && event.from) {
      enqueue({ type: 'unlink', filename: event.from });
      enqueue({ type: 'add', filename: event.filename });
      return;
    }
    if (syncActive) {
      pendingWatcherEvents.push(event);
      return;
    }

    if (
      event.type === 'unlink' &&
      event.filename.endsWith('.md') &&
      getFileHash &&
      computeFileHash
    ) {
      const hash = getFileHash(event.filename);
      if (hash) {
        const timer = window.setTimeout(() => {
          pendingDeletes.delete(event.filename);
          pushToQueue(event);
        }, RENAME_DETECT_WINDOW_MS);
        pendingDeletes.set(event.filename, { hash, timer });
        return;
      }
    }

    if (
      event.type === 'add' &&
      event.filename.endsWith('.md') &&
      computeFileHash &&
      pendingDeletes.size > 0
    ) {
      void (async () => {
        const newHash = await computeFileHash(event.filename);
        if (newHash) {
          for (const [deletedFilename, pending] of pendingDeletes) {
            if (pending.hash === newHash) {
              clearTimeout(pending.timer);
              pendingDeletes.delete(deletedFilename);
              pushToQueue({ type: 'unlink', filename: deletedFilename });
              pushToQueue(event);
              return;
            }
          }
        }
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
      const unhandled = pendingWatcherEvents.filter(
        (ev) =>
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
