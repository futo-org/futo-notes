import type { WatcherBatch } from './watcherBatch';
import type { LocalizedMessage } from '$shared/localization';

export interface SyncCoordinatorDeps {
  watcherBatch: WatcherBatch;
  getEditVersion: () => number;
  isSavePending: () => boolean;
  isComposing: () => boolean;
  getLastEditTime: () => number;
}

export interface SyncCoordinatorUI {
  onStatusMessage: (message: LocalizedMessage | null) => void;
  onIndicatorChange: (visible: boolean) => void;
  onOfflineChange: (offline: boolean) => void;
}

export interface SyncCoordinator {
  shouldDeferSync: () => boolean;
  captureLiveSyncStartEditVersion: () => void;
  onSyncStateChange: (active: boolean) => void;
  onOfflineChange: (offline: boolean) => void;
  getSyncStartEditVersion: () => number;
  getLiveSyncStartEditVersion: () => number;
  setStatusWithTimeout: (message: LocalizedMessage, milliseconds: number) => void;
  destroy: () => void;
}

export function createSyncCoordinator(
  deps: SyncCoordinatorDeps,
  ui: SyncCoordinatorUI,
): SyncCoordinator {
  let syncStartEditVersion = 0;
  let liveSyncStartEditVersion = 0;
  let syncStatusClearTimer: number | null = null;
  let syncIndicatorTimer: number | null = null;

  function shouldDeferSync(): boolean {
    return deps.isSavePending() || deps.isComposing() || Date.now() - deps.getLastEditTime() < 1000;
  }

  function captureSyncStartEditVersion(): void {
    syncStartEditVersion = deps.getEditVersion();
  }

  function captureLiveSyncStartEditVersion(): void {
    liveSyncStartEditVersion = deps.getEditVersion();
  }

  function onSyncStateChange(active: boolean): void {
    deps.watcherBatch.setSyncActive(active);
    if (active) {
      captureSyncStartEditVersion();
      if (syncStatusClearTimer !== null) {
        clearTimeout(syncStatusClearTimer);
        syncStatusClearTimer = null;
      }
      ui.onStatusMessage({ path: 'sync.status.syncing' });
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

  function getLiveSyncStartEditVersion(): number {
    return liveSyncStartEditVersion;
  }

  function setStatusWithTimeout(message: LocalizedMessage, milliseconds: number): void {
    if (syncStatusClearTimer !== null) {
      clearTimeout(syncStatusClearTimer);
      syncStatusClearTimer = null;
    }
    ui.onStatusMessage(message);
    syncStatusClearTimer = window.setTimeout(() => {
      ui.onStatusMessage(null);
      syncStatusClearTimer = null;
    }, milliseconds);
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
    captureLiveSyncStartEditVersion,
    onSyncStateChange,
    onOfflineChange,
    getSyncStartEditVersion,
    getLiveSyncStartEditVersion,
    setStatusWithTimeout,
    destroy,
  };
}
