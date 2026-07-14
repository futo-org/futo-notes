import { listen } from '@tauri-apps/api/event';
import { updateAppState } from '$lib/appState';
import { startAutoSyncV2, stopAutoSyncV2, notifySavedV2, type SyncTrigger } from '$lib/autoSyncV2';
import { createSyncCoordinator, type SyncCoordinator } from '$lib/syncCoordinator';
import { getSyncErrorMessage } from '$lib/syncErrorMessage';
import {
  getNoteById,
  handleExternalFileChange,
  noteExists,
  readNote,
  refreshNotesFromStorage,
} from '$lib/notes.svelte';
import { isTauri, hasFileSystem } from '$lib/platform';
import type { FileChangeEvent } from '$lib/platform/types';
import type { NoteSession } from '$lib/noteSession.svelte';
import type { SyncSummary } from '$lib/syncServiceE2ee';
import { createWatcherBatch } from '$lib/watcherBatch';
import { writeSuppressor } from '$lib/writeSuppression';
import { getLocalNoteStore } from '$lib/localNoteStore';

export { getSyncErrorMessage } from '$lib/syncErrorMessage';

export interface SyncManagerDeps {
  session: NoteSession;
  showToast: (message: string) => void;
  onRename: (fromId: string, toId: string, title: string) => void;
  pruneTabsForDeletedIds: (ids: string[]) => void;
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

type SyncErrorSource = 'sync' | 'stream';

function isCollisionVariant(sourceId: string, candidateId: string): boolean {
  return candidateId.startsWith(`${sourceId} (`) && /\(\d+\)$/.test(candidateId);
}

export function findActiveSyncRename(
  summary: Pick<SyncSummary, 'updatedIds' | 'deletedIds' | 'renamed'>,
  originalId: string,
  recentRenameTarget?: string | null,
): { fromId: string; toId: string } | null {
  const explicit = summary.renamed.find((rename) => rename.fromId === originalId);
  if (explicit) return explicit;
  if (recentRenameTarget && recentRenameTarget !== originalId) {
    return { fromId: originalId, toId: recentRenameTarget };
  }
  if (!summary.deletedIds.includes(originalId)) return null;
  const collision = summary.updatedIds.find((id) => isCollisionVariant(originalId, id));
  return collision ? { fromId: originalId, toId: collision } : null;
}

// eslint-disable-next-line max-lines-per-function -- One Svelte rune factory owns sync health, watcher buffering, and open-note reconciliation.
export function createSyncManager(deps: SyncManagerDeps): SyncManager {
  let syncStatusMessage = $state('');
  let syncIndicatorVisible = $state(false);
  let syncOffline = $state(false);
  let syncErrorMessage = $state('');
  let syncErrorSource: SyncErrorSource | null = null;
  let live = $state(false);

  let rescanTimer: number | null = null;
  let rescanRunning = false;
  let rescanAgain = false;
  let pendingAdopt: { id: string; content: string } | null = null;
  let coordinator: SyncCoordinator | null = null;

  function raiseError(message: string, source: SyncErrorSource = 'sync'): void {
    const changed = message !== syncErrorMessage;
    syncErrorMessage = message;
    syncErrorSource = source;
    if (changed) deps.showToast(`Sync error: ${message}`);
  }

  function clearError(source?: SyncErrorSource): void {
    if (source && syncErrorSource && source !== syncErrorSource) return;
    syncErrorMessage = '';
    syncErrorSource = null;
  }

  async function runRescan(): Promise<void> {
    if (!hasFileSystem) return;
    if (rescanRunning) {
      rescanAgain = true;
      return;
    }
    rescanRunning = true;
    try {
      await refreshNotesFromStorage();
    } catch (error) {
      console.warn('External rescan failed:', error);
    } finally {
      rescanRunning = false;
      if (rescanAgain) {
        rescanAgain = false;
        scheduleRescan(250);
      }
    }
  }

  function scheduleRescan(delayMs = 800): void {
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      rescanTimer = null;
      void runRescan();
    }, delayMs);
  }

  async function preserveDraft(message = 'Open note changed externally; keeping local draft') {
    deps.showToast(message);
    await refreshNotesFromStorage();
    scheduleRescan(250);
  }

  function deferAdopt(id: string, content: string): void {
    pendingAdopt = { id, content };
  }

  async function reconcileDeferredAdopt(): Promise<void> {
    const pending = pendingAdopt;
    pendingAdopt = null;
    if (!pending || deps.session.originalId !== pending.id) return;
    if (deps.session.editorContent === pending.content) return;
    if (deps.session.dirty) {
      await preserveDraft();
      return;
    }
    deps.session.applyExternalContent(pending.content);
  }

  async function handleEditorFocusChange(focused: boolean): Promise<void> {
    if (!focused) await reconcileDeferredAdopt();
  }

  async function handleFileChange(event: FileChangeEvent): Promise<void> {
    const { type, filename } = event;
    if (!filename.endsWith('.md')) return;
    if (writeSuppressor.isRecentSyncWrite(filename) || writeSuppressor.isRecentWrite(filename)) {
      return;
    }

    const id = filename.slice(0, -3);
    if (type === 'unlink' && writeSuppressor.getRecentRemoteRename(id)) return;
    const isOpen = deps.session.originalId === id;
    if (isOpen && deps.session.savePending && type === 'change') return;

    if (isOpen && deps.session.dirty && (type === 'change' || type === 'unlink')) {
      await preserveDraft(
        type === 'unlink'
          ? 'Open note was deleted externally; keeping local draft'
          : 'Open note changed externally; keeping local draft',
      );
      return;
    }

    if (isOpen && type === 'unlink') {
      deps.session.cancelAndClear();
      deps.showToast('Note was deleted externally');
    } else if (isOpen && type === 'change') {
      try {
        const fresh = await readNote(id);
        if (deps.session.editorFocused) deferAdopt(id, fresh);
        else deps.session.applyExternalContent(fresh);
      } catch {
        // Watchers can race an atomic rename; the cache refresh below retries.
      }
    }

    await handleExternalFileChange(filename);
    if (type === 'add' || type === 'change') notifySavedV2();
  }

  async function handleBulkWatcherRefresh(events: FileChangeEvent[]): Promise<void> {
    scheduleRescan(250);
    const openId = deps.session.originalId;
    if (!openId) return;
    const activeEvent = events.find((event) => event.filename === `${openId}.md`);
    if (activeEvent) await handleFileChange(activeEvent);
  }

  const watcherBatch = createWatcherBatch({
    onEvent: handleFileChange,
    onBulkRefresh: handleBulkWatcherRefresh,
    suppressor: writeSuppressor,
  });

  function handleLiveState(payload: LiveStatePayload): void {
    live = payload.live;
    if (payload.message) {
      raiseError(payload.message, payload.status === 'cycle-error' ? 'sync' : 'stream');
    } else if (payload.live) {
      clearError('stream');
    }
  }

  function reportOutcome(summary: SyncSummary, trigger?: SyncTrigger): void {
    if (summary.failureMessage) raiseError(summary.failureMessage);
    else {
      clearError('sync');
      if (trigger === 'manual') deps.showToast('Sync complete');
    }
    void updateAppState({ lastSyncedAt: Date.now() }).catch((error) => {
      console.warn('Failed to persist lastSyncedAt:', error);
    });
  }

  function recordSyncEffects(summary: SyncSummary): void {
    for (const id of summary.updatedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const id of summary.deletedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const rename of summary.renamed) {
      writeSuppressor.recordSyncWrite(`${rename.fromId}.md`);
      writeSuppressor.recordSyncWrite(`${rename.toId}.md`);
      writeSuppressor.recordRemoteRename(rename.fromId, rename.toId);
    }
    if (
      summary.peerUpdatedIds.length > 0 ||
      summary.peerDeletedIds.length > 0 ||
      summary.renamed.length > 0
    ) {
      // Sync writes bypass the local-note store's mutation methods. Reconcile
      // the Rust-owned index once for the peer-driven batch; pure push echoes
      // need no work because local mutations already updated the index.
      void getLocalNoteStore().then((store) => store.rescan());
      window.setTimeout(() => void runRescan(), 50);
    }
  }

  function applyRename(fromId: string, toId: string): void {
    const slash = toId.lastIndexOf('/');
    const title = getNoteById(toId)?.title ?? (slash === -1 ? toId : toId.slice(slash + 1));
    deps.onRename(fromId, toId, title);
    if (deps.session.originalId === fromId) deps.session.applyRemoteRename(toId, title);
  }

  async function keepOrCloseDeletedOpenNote(openId: string): Promise<string | null> {
    if (deps.session.dirty) {
      await preserveDraft('Open note was deleted during sync; keeping local draft');
      return openId;
    }
    deps.session.cancelAndClear();
    deps.showToast('Note was deleted during sync');
    return null;
  }

  async function reconcileOpenNote(summary: SyncSummary): Promise<string | null> {
    const openId = deps.session.originalId;
    if (!openId) return null;
    const deleted = summary.deletedIds.includes(openId);
    const updated = summary.updatedIds.includes(openId);
    if (!deleted && !updated) return null;

    let gone = false;
    if (deleted) {
      try {
        gone = !(await noteExists(openId));
      } catch {
        gone = true;
      }
    }
    if (deps.session.originalId !== openId) return null;
    if (gone) return keepOrCloseDeletedOpenNote(openId);

    try {
      const fresh = await readNote(openId);
      if (deleted && fresh === '') {
        try {
          gone = !(await noteExists(openId));
        } catch {
          gone = true;
        }
      }
      if (deps.session.originalId !== openId) return null;
      if (gone) return keepOrCloseDeletedOpenNote(openId);

      if (fresh !== deps.session.editorContent) {
        const editedDuringSync =
          deps.session.editVersion !== (coordinator?.getSyncStartEditVersion() ?? 0);
        if (!editedDuringSync && !deps.session.dirty) {
          if (deps.session.editorFocused) deferAdopt(openId, fresh);
          else deps.session.applyExternalContent(fresh);
        }
      }
      const meta = getNoteById(openId);
      if (meta) deps.session.applyRemoteRename(openId, meta.title);
    } catch {
      if (deps.session.originalId === openId) {
        deps.showToast('Open note changed during sync; keeping local draft');
      }
    }
    return null;
  }

  async function pruneDeletedTabs(summary: SyncSummary, keptDraftId: string | null) {
    const candidates = summary.deletedIds.filter((id) => id !== keptDraftId);
    const existence = await Promise.all(candidates.map((id) => noteExists(id).catch(() => true)));
    const gone = candidates.filter((_, index) => !existence[index]);
    if (gone.length > 0) deps.pruneTabsForDeletedIds(gone);
  }

  async function handleSyncComplete(summary: SyncSummary, trigger?: SyncTrigger): Promise<void> {
    reportOutcome(summary, trigger);
    recordSyncEffects(summary);

    const activeBeforeRenames = deps.session.originalId;
    const activeRename = activeBeforeRenames
      ? findActiveSyncRename(summary, activeBeforeRenames)
      : null;
    const applied = new Set<string>();
    for (const rename of summary.renamed) {
      applyRename(rename.fromId, rename.toId);
      applied.add(`${rename.fromId}\n${rename.toId}`);
    }
    if (activeRename && !applied.has(`${activeRename.fromId}\n${activeRename.toId}`)) {
      writeSuppressor.recordRemoteRename(activeRename.fromId, activeRename.toId);
      applyRename(activeRename.fromId, activeRename.toId);
    }

    const keptDraftId = await reconcileOpenNote(summary);
    await pruneDeletedTabs(summary, keptDraftId);

    const totalChanges =
      summary.updatedIds.length + summary.deletedIds.length + summary.renamed.length;
    if (totalChanges > 20 && !summary.failureMessage) {
      coordinator?.setStatusWithTimeout('Sync complete', 3000);
    } else {
      syncStatusMessage = '';
    }
  }

  function start(): () => void {
    coordinator = createSyncCoordinator(
      {
        watcherBatch,
        getEditVersion: () => deps.session.editVersion,
        isSavePending: () => deps.session.savePending,
        isComposing: () => deps.session.composing,
        getLastEditTime: () => deps.session.lastEditTime,
      },
      {
        onStatusMessage: (message) => (syncStatusMessage = message),
        onIndicatorChange: (visible) => (syncIndicatorVisible = visible),
        onOfflineChange: (offline) => (syncOffline = offline),
      },
    );

    const activeCoordinator = coordinator;
    startAutoSyncV2({
      onSyncComplete: handleSyncComplete,
      onSyncError: (error) => {
        raiseError(getSyncErrorMessage(error));
        console.warn('Auto-sync error:', error);
      },
      flushPendingSave: deps.session.flushSave,
      shouldDeferSync: activeCoordinator.shouldDeferSync,
      onOfflineChange: activeCoordinator.onOfflineChange,
      onSyncStateChange: activeCoordinator.onSyncStateChange,
    });

    let unlisteners: Array<() => void> = [];
    if (isTauri) {
      void listen('sync:live-synced', (event) => {
        void handleSyncComplete(event.payload as SyncSummary);
      }).then((unlisten) => unlisteners.push(unlisten));
      void listen<LiveStatePayload>('sync:live-state', (event) =>
        handleLiveState(event.payload),
      ).then((unlisten) => unlisteners.push(unlisten));
    }

    return () => {
      stopAutoSyncV2();
      if (rescanTimer !== null) clearTimeout(rescanTimer);
      rescanTimer = null;
      for (const unlisten of unlisteners) unlisten();
      unlisteners = [];
      watcherBatch.destroy();
      activeCoordinator.destroy();
      if (coordinator === activeCoordinator) coordinator = null;
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
      return syncErrorMessage !== '';
    },
    get syncErrorMessage() {
      return syncErrorMessage;
    },
    get live() {
      return live;
    },
    enqueueFileChange: watcherBatch.enqueue,
    handleEditorFocusChange,
    notifySaved: notifySavedV2,
    clearSyncError: () => clearError(),
    start,
    handleSyncComplete,
    handleFileChange,
    handleLiveState,
  };
}
