import { listen } from '@tauri-apps/api/event';
import { isTauri } from '$lib/platform';
import type { NoteSession, ParkedDraftSnapshot } from '$features/notes/noteSession.svelte';
import { writeSuppressor } from '$lib/platform/writeSuppression';
import { createSyncCoordinator, type SyncCoordinator } from './syncCoordinator';
import type { FileChangeEvent } from '$lib/platform/types';
import type { SyncSummary } from './syncServiceE2ee';
import { startAutoSyncV2, stopAutoSyncV2, notifySavedV2, type SyncTrigger } from './autoSyncV2';
import {
  createExternalChangeCoordinator,
  type OpenNoteReconcileResult,
} from './createExternalChangeCoordinator';
import {
  classifySyncError,
  syncErrorDedupeKey,
  type SyncErrorClass,
} from './syncErrorClassification';
import { createSyncCompletionReconciler } from './reconcileSyncCompletion';
import { resolveLocalizedMessage, type LocalizedMessage } from '$shared/localization';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';

export interface SyncManagerDeps {
  session: NoteSession;
  showToast: (message: ToastMessage) => void;
  onRename: (fromId: string, toId: string, title: string) => void;
  pruneTabsForDeletedIds: (goneIds: string[]) => void;
}

export interface SyncManager {
  readonly syncStatusMessage: string;
  readonly syncIndicatorVisible: boolean;
  readonly syncOffline: boolean;
  readonly syncError: boolean;
  readonly syncErrorMessage: string;
  readonly reconnecting: boolean;
  readonly live: boolean;

  enqueueFileChange: (event: FileChangeEvent) => void;

  handleEditorFocusChange: (focused: boolean) => Promise<void>;
  handleEditorCompositionEnd: () => Promise<void>;

  reconcileOpenNote: (
    id: string,
    parkedDraft: ParkedDraftSnapshot,
  ) => Promise<OpenNoteReconcileResult>;

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

// The 2026-08-24 post-wake tailnet outage recovered after 2m34s. Three
// minutes keeps that canonical transient failure quiet while ensuring a dead
// server still becomes actionable during the same working session.
const RECONNECTING_GRACE_MS = 180_000;

function syncErrorForSource(source: SyncErrorSource): LocalizedMessage {
  return source === 'stream'
    ? { path: 'sync.errors.liveUnavailable' }
    : { path: 'sync.errors.completedWithErrors' };
}

function createSyncFailureState(showToast: (message: ToastMessage) => void) {
  let syncError = $state(false);
  let syncErrorMessage = $state<LocalizedMessage | null>(null);
  let syncErrorDiagnostic = '';
  let reconnecting = $state(false);
  const syncErrors: Partial<Record<SyncErrorSource, string>> = {};
  const reconnectingSince: Record<SyncErrorSource, number | null> = {
    sync: null,
    stream: null,
  };
  const transientEscalated: Record<SyncErrorSource, boolean> = {
    sync: false,
    stream: false,
  };

  function raiseSyncError(message: string, source: SyncErrorSource = 'sync'): void {
    const changed = message !== syncErrorDiagnostic;
    syncError = true;
    syncErrorMessage = syncErrorForSource(source);
    syncErrorDiagnostic = message;
    syncErrors[source] = message;
    if (changed) showToast(syncErrorMessage);
  }

  function clearSyncError(source?: SyncErrorSource): void {
    if (!source) {
      delete syncErrors.sync;
      delete syncErrors.stream;
    } else {
      delete syncErrors[source];
    }
    const remainingSource = (['stream', 'sync'] as const).find(
      (candidate) => syncErrors[candidate] !== undefined,
    );
    if (remainingSource) {
      syncError = true;
      syncErrorMessage = syncErrorForSource(remainingSource);
      syncErrorDiagnostic = syncErrors[remainingSource] ?? '';
    } else {
      syncError = false;
      syncErrorMessage = null;
      syncErrorDiagnostic = '';
    }
  }

  function clearReconnecting(source?: SyncErrorSource): void {
    if (source) {
      reconnectingSince[source] = null;
    } else {
      reconnectingSince.sync = null;
      reconnectingSince.stream = null;
    }
    reconnecting = Object.values(reconnectingSince).some((startedAt) => startedAt !== null);
  }

  function clearFailure(source: SyncErrorSource): void {
    clearSyncError(source);
    clearReconnecting(source);
    transientEscalated[source] = false;
  }

  function reportFailure(
    message: string,
    options: { source: SyncErrorSource; class: SyncErrorClass; immediate?: boolean },
  ): void {
    const { source } = options;
    if (options.immediate || options.class === 'actionable') {
      clearReconnecting(source);
      if (options.class === 'transient') transientEscalated[source] = true;
      raiseSyncError(message, source);
      return;
    }

    if (transientEscalated[source]) {
      raiseSyncError(message, source);
      return;
    }

    if (syncErrors[source] !== undefined) {
      raiseSyncError(message, source);
      return;
    }

    const startedAt = reconnectingSince[source];
    if (startedAt === null) {
      reconnectingSince[source] = Date.now();
      reconnecting = true;
      return;
    }
    if (Date.now() - startedAt >= RECONNECTING_GRACE_MS) {
      clearReconnecting(source);
      transientEscalated[source] = true;
      raiseSyncError(message, source);
    }
  }

  function reportActionableSyncFailure(message: string): void {
    reportFailure(message, { source: 'sync', class: 'actionable', immediate: true });
  }

  return {
    get syncError() {
      return syncError;
    },
    get syncErrorMessage() {
      return syncErrorMessage;
    },
    get reconnecting() {
      return reconnecting;
    },
    clearError: clearSyncError,
    clearSource: clearFailure,
    reportActionableSyncFailure,
    reportFailure,
  };
}

export function createSyncManager(deps: SyncManagerDeps): SyncManager {
  let syncStatus = $state<LocalizedMessage | null>(null);
  let syncIndicatorVisible = $state(false);
  let syncOffline = $state(false);
  let live = $state(false);
  const failureState = createSyncFailureState(deps.showToast);

  const notifySaved = notifySavedV2;

  // The one way an engine-reported rename reaches the UI, whichever path
  // applies it: the executor's FollowRename verdict or sync completion's
  // background projection. Tab/route and open session move together, so they
  // can never disagree about which note is open — projecting only the tab
  // retargeted the route to the new title while the title input kept the old
  // one whenever the open note's classification could not answer (job 215292).
  // Applying a reported rename without a verdict is not a shell decision: a
  // reported rename outranks every other fact in the classifier and always
  // yields FollowRename (futo-notes-sync open_note.rs).
  function applyReportedRename(fromId: string, toId: string, title: string): void {
    deps.onRename(fromId, toId, title);
    if (deps.session.originalId === fromId) {
      deps.session.applyRemoteRename(toId, title);
    }
  }

  const externalChanges = createExternalChangeCoordinator({
    followRename: (fromId, toId) => {
      const slash = toId.lastIndexOf('/');
      applyReportedRename(fromId, toId, slash === -1 ? toId : toId.slice(slash + 1));
    },
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
      const source = payload.status === 'cycle-error' ? 'sync' : 'stream';
      const message = syncErrorDedupeKey(payload.message);
      const errorClass =
        payload.status === 'reconnecting' || payload.status === 'cycle-error'
          ? classifySyncError(payload.message)
          : 'actionable';
      failureState.reportFailure(message, { source, class: errorClass });
    } else if (payload.live) {
      failureState.clearSource('stream');
    }
  }

  const handleSyncComplete = createSyncCompletionReconciler({
    dependencies: { ...deps, onRename: applyReportedRename },
    externalChanges,
    writeSuppressor,
    raiseSyncError: failureState.reportActionableSyncFailure,
    clearSyncError: () => {
      failureState.clearSource('sync');
    },
    getSyncStartEditVersion: (trigger) =>
      trigger === undefined
        ? (syncCoord?.getLiveSyncStartEditVersion() ?? 0)
        : (syncCoord?.getSyncStartEditVersion() ?? 0),
    setCompletionStatus: (message, durationMs) =>
      syncCoord?.setStatusWithTimeout(message, durationMs),
    setSyncStatusMessage: (message) => (syncStatus = message),
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
        onStatusMessage: (message) => (syncStatus = message),
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
      onSyncError: (err, trigger) => {
        failureState.reportFailure(syncErrorDedupeKey(err), {
          source: 'sync',
          class: classifySyncError(err),
          immediate: trigger === 'manual',
        });
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
        // The live epoch advances only at completion arrival: any Rust-emitted
        // cycle-start (or connect) signal reaches this webview asynchronously,
        // so an edit racing that dispatch could be captured as pre-cycle and
        // adopted over. Capturing here — synchronously, after this completion
        // has snapshotted the previous epoch, before its async processing —
        // keeps the epoch never meaningfully newer than the next cycle's true
        // start; edits between cycles (or while offline) are over-protected
        // instead: the draft wins, which is the safe direction.
        const completion = handleSyncComplete(e.payload as SyncSummary);
        coord.captureLiveSyncStartEditVersion();
        void completion;
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
      return syncStatus ? resolveLocalizedMessage(syncStatus) : '';
    },
    get syncIndicatorVisible() {
      return syncIndicatorVisible;
    },
    get syncOffline() {
      return syncOffline;
    },
    get syncError() {
      return failureState.syncError;
    },
    get syncErrorMessage() {
      return failureState.syncErrorMessage
        ? resolveLocalizedMessage(failureState.syncErrorMessage)
        : '';
    },
    get reconnecting() {
      return failureState.reconnecting;
    },
    get live() {
      return live;
    },

    enqueueFileChange: (event: FileChangeEvent) => watcherBatch.enqueue(event),
    handleEditorFocusChange: externalChanges.handleEditorFocusChange,
    handleEditorCompositionEnd: externalChanges.handleCompositionEnd,
    reconcileOpenNote: (id: string, parkedDraft: ParkedDraftSnapshot) =>
      externalChanges.reconcileOpenNote(id, { parkedDraft }),
    notifySaved,
    clearSyncError: failureState.clearError,

    start,
    handleSyncComplete,
    handleFileChange: externalChanges.handleFileChange,
    handleLiveState,
  };
}
