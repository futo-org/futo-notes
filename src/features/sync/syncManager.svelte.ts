import { listen } from '@tauri-apps/api/event';
import { isTauri } from '$lib/platform';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { writeSuppressor } from '$lib/platform/writeSuppression';
import { createSyncCoordinator, type SyncCoordinator } from './syncCoordinator';
import type { FileChangeEvent } from '$lib/platform/types';
import type { SyncSummary } from './syncServiceE2ee';
import { startAutoSyncV2, stopAutoSyncV2, notifySavedV2, type SyncTrigger } from './autoSyncV2';
import { createExternalChangeCoordinator } from './createExternalChangeCoordinator';
import { getSyncErrorMessage } from './syncErrorMessage';
import { createSyncCompletionReconciler } from './reconcileSyncCompletion';

export { findActiveSyncRename } from './reconcileSyncCompletion';
export { getSyncErrorMessage } from './syncErrorMessage';

export interface SyncManagerDeps {
  session: NoteSession;
  showToast: (message: string) => void;
  onRename: (fromId: string, toId: string, title: string) => void;
  pruneTabsForDeletedIds: (goneIds: string[]) => void;
}

export interface SyncManager {
  readonly syncStatusMessage: string;
  readonly syncIndicatorVisible: boolean;
  readonly syncOffline: boolean;
  readonly syncError: boolean;
  readonly syncErrorMessage: string;
  readonly live: boolean;

  enqueueFileChange: (event: FileChangeEvent) => void;

  handleEditorFocusChange: (focused: boolean) => Promise<void>;

  notifySaved: () => void;

  clearSyncError: () => void;

  start: () => () => void;

  handleSyncComplete: (summary: SyncSummary, trigger?: SyncTrigger) => Promise<void>;
  handleFileChange: (event: FileChangeEvent) => Promise<void>;
  handleLiveState: (payload: LiveStatePayload) => void;
}

export interface LiveStatePayload {
  live: boolean;
  status: string;
  message?: string;
}

export type SyncErrorSource = 'sync' | 'stream';

export function createSyncManager(deps: SyncManagerDeps): SyncManager {
  let syncStatusMessage = $state('');
  let syncIndicatorVisible = $state(false);
  let syncOffline = $state(false);
  let syncError = $state(false);
  let syncErrorMessage = $state('');
  let live = $state(false);
  let syncErrorSource: SyncErrorSource | null = null;

  function raiseSyncError(message: string, source: SyncErrorSource = 'sync'): void {
    const changed = message !== syncErrorMessage;
    syncError = true;
    syncErrorMessage = message;
    syncErrorSource = source;
    if (changed) deps.showToast(`Sync error: ${message}`);
  }

  function clearSyncError(source?: SyncErrorSource): void {
    if (source && syncErrorSource !== null && syncErrorSource !== source) return;
    syncError = false;
    syncErrorMessage = '';
    syncErrorSource = null;
  }

  const notifySaved = () => {
    notifySavedV2();
  };

  const externalChanges = createExternalChangeCoordinator({
    session: deps.session,
    notifySaved,
    showToast: deps.showToast,
    writeSuppressor,
  });
  const watcherBatch = externalChanges.watcherBatch;

  let syncCoord: SyncCoordinator | null = null;

  function handleLiveState(payload: LiveStatePayload): void {
    live = payload.live;
    if (payload.message) {
      raiseSyncError(payload.message, payload.status === 'cycle-error' ? 'sync' : 'stream');
    } else if (payload.live) {
      clearSyncError('stream');
    }
  }

  const handleSyncComplete = createSyncCompletionReconciler({
    dependencies: deps,
    externalChanges,
    writeSuppressor,
    raiseSyncError: (message) => raiseSyncError(message),
    clearSyncError: () => clearSyncError('sync'),
    getSyncStartEditVersion: () => syncCoord?.getSyncStartEditVersion() ?? 0,
    setCompletionStatus: (message, durationMs) =>
      syncCoord?.setStatusWithTimeout(message, durationMs),
    setSyncStatusMessage: (message) => {
      syncStatusMessage = message;
    },
  });

  function start(): () => void {
    syncCoord = createSyncCoordinator(
      {
        watcherBatch,
        getEditVersion: () => deps.session.editVersion,
        isSavePending: () => deps.session.savePending,
        isComposing: () => deps.session.composing,
        getLastEditTime: () => deps.session.lastEditTime,
      },
      {
        onStatusMessage: (msg) => {
          syncStatusMessage = msg;
        },
        onIndicatorChange: (visible) => {
          syncIndicatorVisible = visible;
        },
        onOfflineChange: (offline) => {
          syncOffline = offline;
        },
      },
    );
    const coord = syncCoord;
    startAutoSyncV2({
      onSyncComplete: (summary, trigger) => void handleSyncComplete(summary, trigger),
      onSyncError: (err) => {
        raiseSyncError(getSyncErrorMessage(err));
        console.warn('Auto-sync error:', err);
      },
      flushPendingSave: deps.session.flushSave,
      shouldDeferSync: coord.shouldDeferSync,
      onOfflineChange: coord.onOfflineChange,
      onSyncStateChange: coord.onSyncStateChange,
    });

    let liveUnlisteners: Array<() => void> = [];
    if (isTauri) {
      void listen('sync:live-synced', (e) => {
        void handleSyncComplete(e.payload as SyncSummary);
      }).then((un) => liveUnlisteners.push(un));
      void listen<LiveStatePayload>('sync:live-state', (e) => handleLiveState(e.payload)).then(
        (un) => liveUnlisteners.push(un),
      );
    }

    return () => {
      stopAutoSyncV2();
      for (const un of liveUnlisteners) un();
      liveUnlisteners = [];
      externalChanges.stop();
      syncCoord?.destroy();
    };
  }

  return {
    get syncStatusMessage() {
      return syncStatusMessage;
    },
    get syncIndicatorVisible() {
      return syncIndicatorVisible;
    },
    get syncOffline() {
      return syncOffline;
    },
    get syncError() {
      return syncError;
    },
    get syncErrorMessage() {
      return syncErrorMessage;
    },
    get live() {
      return live;
    },

    enqueueFileChange: (event: FileChangeEvent) => watcherBatch.enqueue(event),
    handleEditorFocusChange: externalChanges.handleEditorFocusChange,
    notifySaved,
    clearSyncError,

    start,
    handleSyncComplete,
    handleFileChange: externalChanges.handleFileChange,
    handleLiveState,
  };
}
