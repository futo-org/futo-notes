/**
 * Sync manager — owns sync coordination state and lifecycle.
 *
 * Extracted from NotesShell.svelte so sync logic is independently testable
 * and the shell becomes a pure layout component.
 *
 * Created via `createSyncManager(deps)` which returns reactive state for
 * the template and imperative methods for the watcher and dev hooks.
 */

import { hasFileSystem } from '$lib/platform';
import { writeSuppressor as sharedWriteSuppressor, type WriteSuppressor } from '$lib/writeSuppression';
import { createWatcherBatch, type WatcherBatch } from '$lib/watcherBatch';
import { createSyncCoordinator, type SyncCoordinator } from '$lib/syncCoordinator';
import type { FileChangeEvent } from '$lib/platform/types';
import type { SyncSummary } from '$lib/syncServiceE2ee';
import {
  readNote,
  getNoteById,
  handleExternalFileChange,
  refreshNotesFromStorage,
} from '$lib/notes.svelte';
import { startAutoSyncV2, stopAutoSyncV2, notifySavedV2 } from '$lib/autoSyncV2';

// ── Dependency interface ─────────────────────────────────────────────────

export interface SyncManagerDeps {
  // Session
  getOriginalId: () => string | null;
  getEditVersion: () => number;
  isSavePending: () => boolean;
  hasOpenDraftChanges: () => boolean;
  getLastEditTime: () => number;
  applyExternalContent: (content: string) => void;
  applyRemoteRename: (newId: string, newTitle: string) => void;
  cancelAndClear: () => void;
  flushSave: () => Promise<void>;
  seedOpenNote?: (id: string, body: string) => void;

  // Editor
  getEditorContent: () => string | undefined;
  isComposing: () => boolean;

  // Graph
  patchGraphNode: (from: string, to: string, title: string) => void;
  clearGraphData: () => void;

  // UI
  showToast: (message: string) => void;
  navigate: (path: string) => void;
  getNoteId: () => string | null;
  getPrevNoteId: () => string | null | undefined;
  setPrevNoteId: (id: string | null | undefined) => void;
}

// ── Return type ──────────────────────────────────────────────────────────

export interface SyncManager {
  /** Reactive: current sync status message for the UI. */
  readonly syncStatusMessage: string;
  /** Reactive: whether the sync activity indicator is visible. */
  readonly syncIndicatorVisible: boolean;
  /** Reactive: whether the app is offline. */
  readonly syncOffline: boolean;

  /** The write suppressor instance — shared with noteSession. */
  readonly writeSuppressor: WriteSuppressor;
  /** The watcher batch — used for enqueuing file change events. */
  readonly watcherBatch: WatcherBatch;

  /** Enqueue a file-system change event from the native watcher. */
  enqueueFileChange: (event: FileChangeEvent) => void;

  /** Notify auto-sync that a local change happened (save, delete, etc). */
  notifySaved: () => void;

  /** Start sync lifecycle (call in mount $effect). Returns cleanup fn. */
  start: () => () => void;

  // For __notesShellTest dev hook
  handleSyncComplete: (summary: SyncSummary) => Promise<void>;
  handleFileChange: (event: FileChangeEvent) => Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────

function isCollisionVariantId(sourceId: string, candidateId: string): boolean {
  return candidateId.startsWith(`${sourceId} (`) && /\(\d+\)$/.test(candidateId);
}

export function findActiveSyncRename(
  summary: Pick<SyncSummary, 'updatedIds' | 'deletedIds' | 'renamed'>,
  originalId: string,
  recentRenameTarget?: string | null,
): { fromId: string; toId: string } | null {
  const explicitRename = summary.renamed.find((rename) => rename.fromId === originalId);
  if (explicitRename) return explicitRename;
  if (recentRenameTarget && recentRenameTarget !== originalId) {
    return { fromId: originalId, toId: recentRenameTarget };
  }
  if (!summary.deletedIds.includes(originalId)) return null;

  const collisionRenameTarget = summary.updatedIds.find((id) => isCollisionVariantId(originalId, id));
  if (!collisionRenameTarget) return null;

  return { fromId: originalId, toId: collisionRenameTarget };
}

// ── Factory ──────────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function -- Sync lifecycle, watcher coordination, and Svelte rune state are intentionally kept together.
export function createSyncManager(deps: SyncManagerDeps): SyncManager {
  // ── Reactive state (Svelte 5 runes) ──
  let syncStatusMessage = $state('');
  let syncIndicatorVisible = $state(false);
  let syncOffline = $state(false);

  // ── Internal state ──
  let externalRescanTimer: number | null = null;
  let externalRescanInFlight = false;
  let externalRescanQueued = false;

  // ── Write suppressor ──
  // Shared module-level singleton — local note ops (drag-drop folder
  // moves, single-note moves) need to record their own writes so the
  // watcher doesn't fire "Note deleted externally" on the unlink that
  // the local rename produced.
  const writeSuppressor = sharedWriteSuppressor;

  const notifySaved = () => { notifySavedV2(); };

  // ── External rescan ──

  async function runExternalRescan(): Promise<void> {
    if (!hasFileSystem) return;
    if (externalRescanInFlight) {
      externalRescanQueued = true;
      return;
    }
    externalRescanInFlight = true;
    try {
      await refreshNotesFromStorage();
    } catch (e) {
      console.warn('External rescan failed:', e);
    } finally {
      externalRescanInFlight = false;
      if (externalRescanQueued) {
        externalRescanQueued = false;
        scheduleExternalRescan(250);
      }
    }
  }

  function scheduleExternalRescan(delayMs = 800): void {
    if (externalRescanTimer !== null) {
      clearTimeout(externalRescanTimer);
    }
    externalRescanTimer = window.setTimeout(() => {
      externalRescanTimer = null;
      void runExternalRescan();
    }, delayMs);
  }

  // ── Watcher event handlers ──

  async function handleSingleWatcherEvent(event: FileChangeEvent): Promise<void> {
    const { type, filename } = event;
    if (!filename.endsWith('.md')) return;
    if (writeSuppressor.isRecentSyncWrite(filename)) return;
    if (writeSuppressor.isRecentWrite(filename)) return;

    const id = filename.replace(/\.md$/, '');
    if (type === 'unlink' && writeSuppressor.getRecentRemoteRename(id)) return;
    // Suppress change events for open note when save is pending or in-flight
    const originalId = deps.getOriginalId();
    if (id === originalId && deps.isSavePending() && type === 'change') return;
    if (id === originalId && deps.hasOpenDraftChanges() && (type === 'change' || type === 'unlink')) {
      deps.showToast(
        type === 'unlink'
          ? 'Open note was deleted externally; keeping local draft'
          : 'Open note changed externally; keeping local draft',
      );
      await refreshNotesFromStorage();
      if (type === 'change') {
        scheduleExternalRescan(250);
      }
      return;
    }

    if (type === 'unlink' && id === originalId) {
      deps.cancelAndClear();
      deps.showToast('Note was deleted externally');
    } else if (type === 'change' && id === originalId) {
      try {
        const freshContent = await readNote(id);
        deps.applyExternalContent(freshContent);
      } catch {
        // Ignore read errors for transient file events.
      }
    }

    await handleExternalFileChange(filename);
    if (type === 'add' || type === 'change') {
      scheduleExternalRescan();
    }
    if (type === 'add' || type === 'change') {
      notifySaved();
    }
  }

  async function handleBulkWatcherRefresh(events: FileChangeEvent[]): Promise<void> {
    scheduleExternalRescan(250);

    // Replay the active-note event synchronously so the open editor
    // picks up the change without waiting for the rescan window.
    const originalId = deps.getOriginalId();
    const activeFilename = originalId ? `${originalId}.md` : null;
    if (activeFilename) {
      const activeEvent = events.find(ev => ev.filename === activeFilename);
      if (activeEvent) {
        await handleSingleWatcherEvent(activeEvent);
      }
    }
  }

  // ── Watcher batch ──
  const watcherBatch = createWatcherBatch({
    onEvent: handleSingleWatcherEvent,
    onBulkRefresh: handleBulkWatcherRefresh,
    suppressor: writeSuppressor,
  });

  // ── Sync coordinator (created lazily in start()) ──
  let syncCoord: SyncCoordinator | null = null;

  // ── Sync complete handler ──

  async function handleSyncComplete(summary: SyncSummary): Promise<void> {
    function applyActiveRename(fromId: string, toId: string): void {
      const meta = getNoteById(toId);
      const newTitle = meta?.title ?? toId;
      deps.applyRemoteRename(toId, newTitle);

      deps.patchGraphNode(fromId, toId, newTitle);

      const currentPath = window.location.hash.slice(1) || '/';
      if (currentPath === `/note/${encodeURIComponent(fromId)}`) {
        deps.setPrevNoteId(toId);
        deps.navigate(`/note/${encodeURIComponent(toId)}`);
      }
    }

    // Gate the post-sync rescan on peer-driven changes only. Echoing our
    // own push back through `summary.updatedIds` was forcing a full vault
    // scan + 3.5 MB MiniSearch persist on every keystroke-triggered sync,
    // which is what made typing stutter. Pure pushes leave notesCache and
    // the search index already correct, so there's nothing to rescan.
    const hasPeerNoteChanges =
      summary.peerUpdatedIds.length > 0 ||
      summary.peerDeletedIds.length > 0 ||
      summary.renamed.length > 0;
    for (const id of summary.updatedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const id of summary.deletedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const rename of summary.renamed) {
      writeSuppressor.recordSyncWrite(`${rename.fromId}.md`);
      writeSuppressor.recordSyncWrite(`${rename.toId}.md`);
      writeSuppressor.recordRemoteRename(rename.fromId, rename.toId);
    }
    if (hasPeerNoteChanges) {
      setTimeout(() => runExternalRescan(), 50);
    }

    const originalId = deps.getOriginalId();

    const activeRename = originalId
      ? findActiveSyncRename(summary, originalId)
      : null;
    if (activeRename) {
      applyActiveRename(activeRename.fromId, activeRename.toId);
      if (!summary.renamed.some((rename) => rename.fromId === activeRename.fromId && rename.toId === activeRename.toId)) {
        writeSuppressor.recordRemoteRename(activeRename.fromId, activeRename.toId);
      }
    }

    // Reload only when sync actually touched the currently-open note.
    const currentOriginalId = deps.getOriginalId();
    if (currentOriginalId && (summary.updatedIds.includes(currentOriginalId) || summary.deletedIds.includes(currentOriginalId))) {
      try {
        const freshContent = await readNote(currentOriginalId);
        if (freshContent !== deps.getEditorContent()) {
          const editedDuringSync = deps.getEditVersion() !== (syncCoord?.getSyncStartEditVersion() ?? 0);
          if (!editedDuringSync) {
            deps.applyExternalContent(freshContent);
          }
        }
        // H13: Always refresh metadata even when content was skipped.
        const meta = getNoteById(currentOriginalId);
        if (meta) {
          deps.applyRemoteRename(currentOriginalId, meta.title);
        }
      } catch {
        // If originalId changed during the await (local rename raced with readNote),
        // the file legitimately no longer exists under the old name — skip silently.
        if (deps.getOriginalId() !== currentOriginalId) return;

        const recoveredRename = findActiveSyncRename(
          summary,
          currentOriginalId,
          writeSuppressor.getRecentRemoteRename(currentOriginalId)?.toId ?? null,
        );
        if (recoveredRename && recoveredRename.toId !== currentOriginalId) {
          writeSuppressor.recordRemoteRename(recoveredRename.fromId, recoveredRename.toId);
          applyActiveRename(recoveredRename.fromId, recoveredRename.toId);
        } else {
          deps.showToast('Open note changed during sync; keeping local draft');
        }
      }
    }

    // Sync status banner
    const totalChanges = summary.updatedIds.length + summary.deletedIds.length + summary.renamed.length;
    if (totalChanges > 20) {
      syncCoord?.setStatusWithTimeout(`Synced ${totalChanges} notes`, 3000);
    } else {
      syncStatusMessage = '';
    }
  }

  // ── Lifecycle ──

  function start(): () => void {
    syncCoord = createSyncCoordinator(
      {
        watcherBatch,
        getEditVersion: () => deps.getEditVersion(),
        isSavePending: () => deps.isSavePending(),
        isComposing: () => deps.isComposing(),
        getLastEditTime: () => deps.getLastEditTime(),
      },
      {
        onStatusMessage: (msg) => { syncStatusMessage = msg; },
        onIndicatorChange: (visible) => { syncIndicatorVisible = visible; },
        onOfflineChange: (offline) => { syncOffline = offline; },
      },
    );
    const coord = syncCoord;
    startAutoSyncV2({
      onSyncComplete: handleSyncComplete,
      onSyncError: (err) => console.warn('Auto-sync error:', err),
      flushPendingSave: deps.flushSave,
      shouldDeferSync: coord.shouldDeferSync,
      onOfflineChange: coord.onOfflineChange,
      onSyncStateChange: coord.onSyncStateChange,
    });

    return () => {
      stopAutoSyncV2();
      if (externalRescanTimer !== null) {
        clearTimeout(externalRescanTimer);
        externalRescanTimer = null;
      }
      watcherBatch.destroy();
      syncCoord?.destroy();
    };
  }

  // ── Public API ──

  return {
    get syncStatusMessage() { return syncStatusMessage; },
    get syncIndicatorVisible() { return syncIndicatorVisible; },
    get syncOffline() { return syncOffline; },

    writeSuppressor,
    watcherBatch,

    enqueueFileChange: (event: FileChangeEvent) => watcherBatch.enqueue(event),
    notifySaved,

    start,
    handleSyncComplete,
    handleFileChange: handleSingleWatcherEvent,
  };
}
