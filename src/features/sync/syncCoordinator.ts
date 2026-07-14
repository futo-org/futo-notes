import type { WatcherBatch } from './watcherBatch';

export interface SyncCoordinatorDeps {
  watcherBatch: WatcherBatch;
  getEditVersion: () => number;
  isSavePending: () => boolean;
  isComposing: () => boolean;
  getLastEditTime: () => number;
}

export interface SyncCoordinatorUI {
  onStatusMessage: (msg: string) => void;
  onIndicatorChange: (visible: boolean) => void;
  onOfflineChange: (offline: boolean) => void;
}

export interface SyncCoordinator {
  shouldDeferSync: () => boolean;
  onSyncStateChange: (active: boolean) => void;
  onOfflineChange: (offline: boolean) => void;
  getSyncStartEditVersion: () => number;
  setStatusWithTimeout: (msg: string, ms: number) => void;
  destroy: () => void;
}

export function createSyncCoordinator(
  deps: SyncCoordinatorDeps,
  ui: SyncCoordinatorUI,
): SyncCoordinator {
  let syncStartEditVersion = 0;
  let syncStatusClearTimer: number | null = null;
  let syncIndicatorTimer: number | null = null;

  function shouldDeferSync(): boolean {
    return deps.isSavePending() || deps.isComposing() || Date.now() - deps.getLastEditTime() < 1000;
  }

  function onSyncStateChange(active: boolean): void {
    deps.watcherBatch.setSyncActive(active);
    if (active) {
      syncStartEditVersion = deps.getEditVersion();
      if (syncStatusClearTimer !== null) {
        clearTimeout(syncStatusClearTimer);
        syncStatusClearTimer = null;
      }
      ui.onStatusMessage('Syncing...');
      if (syncIndicatorTimer !== null) {
        clearTimeout(syncIndicatorTimer);
        syncIndicatorTimer = null;
      }
      ui.onIndicatorChange(true);
    }
    if (!active) {
      deps.watcherBatch.drainPostSync();
      if (syncIndicatorTimer === null) {
        syncIndicatorTimer = window.setTimeout(() => {
          ui.onIndicatorChange(false);
          syncIndicatorTimer = null;
        }, 400);
      }
    }
  }

  function onOfflineChange(offline: boolean): void {
    ui.onOfflineChange(offline);
  }

  function getSyncStartEditVersion(): number {
    return syncStartEditVersion;
  }

  function setStatusWithTimeout(msg: string, ms: number): void {
    if (syncStatusClearTimer !== null) {
      clearTimeout(syncStatusClearTimer);
      syncStatusClearTimer = null;
    }
    ui.onStatusMessage(msg);
    syncStatusClearTimer = window.setTimeout(() => {
      ui.onStatusMessage('');
      syncStatusClearTimer = null;
    }, ms);
  }

  function destroy(): void {
    if (syncStatusClearTimer !== null) {
      clearTimeout(syncStatusClearTimer);
      syncStatusClearTimer = null;
    }
    if (syncIndicatorTimer !== null) {
      clearTimeout(syncIndicatorTimer);
      syncIndicatorTimer = null;
    }
  }

  return {
    shouldDeferSync,
    onSyncStateChange,
    onOfflineChange,
    getSyncStartEditVersion,
    setStatusWithTimeout,
    destroy,
  };
}
