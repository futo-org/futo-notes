/**
 * Sync coordinator — connects autoSync callbacks to writeSuppression and
 * watcherBatch, and manages the sync-vs-edit version tracking.
 *
 * The component creates a coordinator in its mount effect, passing in the
 * reactive-state update callbacks. The coordinator builds the
 * `AutoSyncCallbacks` expected by `startAutoSync()`.
 */

import type { WatcherBatch } from './watcherBatch';

export interface SyncCoordinatorDeps {
  /** The watcher batch to notify of sync-active state changes. */
  watcherBatch: WatcherBatch;
  /** Read the current edit version (incremented on every keystroke). */
  getEditVersion: () => number;
  /** Check whether a save is pending or in-flight. */
  isSavePending: () => boolean;
  /** Check whether the editor is in an IME composition. */
  isComposing: () => boolean;
  /** Read the last edit timestamp. */
  getLastEditTime: () => number;
}

export interface SyncCoordinatorUI {
  /** Called with the sync status text to display in the UI. */
  onStatusMessage: (msg: string) => void;
  /** Called to show/hide the sync activity indicator. */
  onIndicatorChange: (visible: boolean) => void;
  /** Called when the network offline state changes. */
  onOfflineChange: (offline: boolean) => void;
}

export interface SyncCoordinator {
  /** `shouldDeferSync` callback for autoSync. */
  shouldDeferSync: () => boolean;
  /** `onSyncStateChange` callback for autoSync. */
  onSyncStateChange: (active: boolean) => void;
  /** `onOfflineChange` callback for autoSync. */
  onOfflineChange: (offline: boolean) => void;
  /** The edit version captured at sync start — compare with current to detect edits during sync. */
  getSyncStartEditVersion: () => number;
  /** Set a status message that auto-clears after `ms` milliseconds.
   *  The clear timer is cancelled if a new sync starts before it fires. */
  setStatusWithTimeout: (msg: string, ms: number) => void;
  /** Clean up timers. */
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
    return (
      deps.isSavePending() ||
      deps.isComposing() ||
      Date.now() - deps.getLastEditTime() < 1000
    );
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
      // Show indicator with minimum 1s display
      if (syncIndicatorTimer !== null) {
        clearTimeout(syncIndicatorTimer);
        syncIndicatorTimer = null;
      }
      ui.onIndicatorChange(true);
    }
    if (!active) {
      deps.watcherBatch.drainPostSync();
      // Keep indicator visible for at least 1s
      if (syncIndicatorTimer === null) {
        syncIndicatorTimer = window.setTimeout(() => {
          ui.onIndicatorChange(false);
          syncIndicatorTimer = null;
        }, 1000);
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
