/**
 * Sync manager — owns sync coordination state and lifecycle.
 *
 * Extracted from NotesShell.svelte so sync logic is independently testable
 * and the shell becomes a pure layout component.
 *
 * Created via `createSyncManager(deps)` which returns reactive state for
 * the template and imperative methods for the watcher and dev hooks.
 */

import { listen } from '@tauri-apps/api/event';
import { hasFileSystem, isTauri } from '$lib/platform';
import {
  writeSuppressor as sharedWriteSuppressor,
  type WriteSuppressor,
} from '$lib/writeSuppression';
import { createWatcherBatch, type WatcherBatch } from '$lib/watcherBatch';
import { createSyncCoordinator, type SyncCoordinator } from '$lib/syncCoordinator';
import type { FileChangeEvent } from '$lib/platform/types';
import type { SyncSummary } from '$lib/syncServiceE2ee';
import {
  readNote,
  noteExists,
  getNoteById,
  handleExternalFileChange,
  refreshNotesFromStorage,
} from '$lib/notes.svelte';
import { startAutoSyncV2, stopAutoSyncV2, notifySavedV2, type SyncTrigger } from '$lib/autoSyncV2';
import { updateAppState } from '$lib/appState';
import { engineNotify } from '$features/search/searchEngine';

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
  /** Whether the editor currently holds focus. Adopting external content into
   *  a focused editor desyncs CM6's async selection/scroll/measure machinery
   *  from the replaced doc and crashes it — see the guards below. */
  isEditorFocused: () => boolean;

  // Graph
  patchGraphNode: (from: string, to: string, title: string) => void;
  clearGraphData: () => void;

  // UI
  showToast: (message: string) => void;
  navigate: (path: string) => void;
  getNoteId: () => string | null;
  getPrevNoteId: () => string | null | undefined;
  setPrevNoteId: (id: string | null | undefined) => void;
  /** Called once per remote-driven rename so the tabs store (and any
   *  other consumer) can patch references that aren't the active note. */
  onAnySyncRename?: (fromId: string, toId: string) => void;
  /** Clear any tab (background or the just-closed active one) still pointing at
   *  a note this sync deleted and did NOT recreate, so switching to that tab
   *  can't resurrect the note via a `loadNote` that reads "" for the missing
   *  file (F4 background-tab vector). The note whose unsaved draft was kept
   *  open is intentionally excluded by the caller. */
  pruneTabsForDeletedIds?: (goneIds: string[]) => void;
}

// ── Return type ──────────────────────────────────────────────────────────

export interface SyncManager {
  /** Reactive: current sync status message for the UI. */
  readonly syncStatusMessage: string;
  /** Reactive: whether the sync activity indicator is visible. */
  readonly syncIndicatorVisible: boolean;
  /** Reactive: whether the app is offline. */
  readonly syncOffline: boolean;
  /** Reactive: whether the last sync attempt failed (cleared on next successful sync). */
  readonly syncError: boolean;
  /** Reactive: human-readable message for the last sync error (empty when none). */
  readonly syncErrorMessage: string;
  /** Reactive: whether the Rust SSE live stream is currently connected. */
  readonly live: boolean;

  /** The write suppressor instance — shared with noteSession. */
  readonly writeSuppressor: WriteSuppressor;
  /** The watcher batch — used for enqueuing file change events. */
  readonly watcherBatch: WatcherBatch;

  /** Enqueue a file-system change event from the native watcher. */
  enqueueFileChange: (event: FileChangeEvent) => void;

  /** Notify the manager when editor focus changes so deferred external adopts
   *  can be reconciled after CM6's focused document state is gone. */
  handleEditorFocusChange: (focused: boolean) => Promise<void>;

  /** Notify auto-sync that a local change happened (save, delete, etc). */
  notifySaved: () => void;

  /** Dismiss the current sync error (✕ indicator + message). A manual dismiss,
   *  NOT a mute — the next failing sync re-raises it. */
  clearSyncError: () => void;

  /** Start sync lifecycle (call in mount $effect). Returns cleanup fn. */
  start: () => () => void;

  // For __notesShellTest dev hook
  handleSyncComplete: (summary: SyncSummary, trigger?: SyncTrigger) => Promise<void>;
  handleFileChange: (event: FileChangeEvent) => Promise<void>;
  /** Exposed for tests — the `sync:live-state` event handler. */
  handleLiveState: (payload: LiveStatePayload) => void;
}

/** Payload of the Rust live loop's `sync:live-state` event. `message` is set
 *  only on error emits: status "reconnecting" (stream down, `live: false`) or
 *  "cycle-error" (a sync cycle failed while the stream stayed up, `live:
 *  true`). */
export interface LiveStatePayload {
  live: boolean;
  status: string;
  message?: string;
}

/** Which surface raised a sync error — see `raiseSyncError`/`clearSyncError`. */
export type SyncErrorSource = 'sync' | 'stream';

// ── Constants ────────────────────────────────────────────────────────────

function isCollisionVariantId(sourceId: string, candidateId: string): boolean {
  return candidateId.startsWith(`${sourceId} (`) && /\(\d+\)$/.test(candidateId);
}

/**
 * Human-readable message for a sync failure. Auto/background sync errors used
 * to be swallowed into `console.warn` only (regression F15); this turns the raw
 * error into the same wording the Settings panel uses for manual-sync failures
 * so the status-bar indicator and Settings agree. `fetch` throws opaque
 * `TypeError`s when the server is unreachable — rewrite those to something a
 * user can act on.
 */
export function getSyncErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(msg)) {
    return "Could not reach server — check the URL and make sure it's running";
  }
  return msg;
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

  const collisionRenameTarget = summary.updatedIds.find((id) =>
    isCollisionVariantId(originalId, id),
  );
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
  let syncError = $state(false);
  let syncErrorMessage = $state('');
  let live = $state(false);
  /** What raised the current error: 'sync' (a cycle failed — poll, manual, or
   *  live cycle-error) or 'stream' (the SSE stream is down). Tracked so each
   *  source only clears its own errors — see `clearSyncError`. */
  let syncErrorSource: SyncErrorSource | null = null;

  /**
   * Raise the sync-failure state (⚠ indicator + Settings line) from a
   * whole-cycle throw, per-item failures, or a live-loop error. The toast
   * fires on any CHANGE of message — the first failure (message was '') and
   * every subsequent DIFFERENT failure — but stays silent on an identical
   * repeat, so a persistent outage that auto-sync retries every ~15s doesn't
   * spam.
   */
  function raiseSyncError(message: string, source: SyncErrorSource = 'sync'): void {
    const changed = message !== syncErrorMessage;
    syncError = true;
    syncErrorMessage = message;
    syncErrorSource = source;
    // Toasts float free of the sync UI, so name the source; the indicator
    // tooltip and Settings line carry their own "Sync error/failed" labels.
    if (changed) deps.showToast(`Sync error: ${message}`);
  }

  /**
   * Clear the error state. With a `source`, only clears an error that source
   * raised: a clean poll proves syncing works but not that the stream
   * recovered, so it must not clear (and re-arm the toast for) a 'stream'
   * error the live loop is still retrying. The click-to-dismiss ⚠ passes no
   * source and clears everything.
   */
  function clearSyncError(source?: SyncErrorSource): void {
    if (source && syncErrorSource !== null && syncErrorSource !== source) return;
    syncError = false;
    syncErrorMessage = '';
    syncErrorSource = null;
  }

  // ── Internal state ──
  let externalRescanTimer: number | null = null;
  let externalRescanInFlight = false;
  let externalRescanQueued = false;
  let pendingExternalAdopt: { id: string; content: string } | null = null;

  // ── Write suppressor ──
  // Shared module-level singleton — local note ops (drag-drop folder
  // moves, single-note moves) need to record their own writes so the
  // watcher doesn't fire "Note deleted externally" on the unlink that
  // the local rename produced.
  const writeSuppressor = sharedWriteSuppressor;

  const notifySaved = () => {
    notifySavedV2();
  };

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
    externalRescanTimer = setTimeout(() => {
      externalRescanTimer = null;
      void runExternalRescan();
    }, delayMs);
  }

  function deferExternalAdopt(id: string, content: string): void {
    pendingExternalAdopt = { id, content };
  }

  async function preserveLocalDraftAfterExternalChange(): Promise<void> {
    deps.showToast('Open note changed externally; keeping local draft');
    await refreshNotesFromStorage();
    scheduleExternalRescan(250);
  }

  async function reconcilePendingExternalAdopt(): Promise<void> {
    if (!pendingExternalAdopt) return;

    const pending = pendingExternalAdopt;
    pendingExternalAdopt = null;

    if (deps.getOriginalId() !== pending.id) return;
    if (pending.content === deps.getEditorContent()) return;

    if (deps.hasOpenDraftChanges()) {
      await preserveLocalDraftAfterExternalChange();
      return;
    }

    deps.applyExternalContent(pending.content);
  }

  async function handleEditorFocusChange(focused: boolean): Promise<void> {
    if (focused) return;
    await reconcilePendingExternalAdopt();
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
    if (
      id === originalId &&
      deps.hasOpenDraftChanges() &&
      (type === 'change' || type === 'unlink')
    ) {
      if (type === 'unlink') {
        deps.showToast('Open note was deleted externally; keeping local draft');
        await refreshNotesFromStorage();
      } else {
        await preserveLocalDraftAfterExternalChange();
      }
      return;
    }

    if (type === 'unlink' && id === originalId) {
      deps.cancelAndClear();
      deps.showToast('Note was deleted externally');
    } else if (type === 'change' && id === originalId) {
      // Never replace the open note's document while its editor is focused:
      // CM6's async DOM-selection/scroll/measure machinery still references
      // pre-update positions, and once the adopted doc shrinks under it CM6
      // throws (RangeError "Selection points outside of document" / "No tile at
      // position N" / "Invalid position N in document"). The single-note cache
      // update below still runs so the note list tracks the change; the editor
      // keeps its current doc until it loses focus, then reconciles below.
      try {
        const freshContent = await readNote(id);
        if (deps.isEditorFocused()) {
          deferExternalAdopt(id, freshContent);
        } else {
          deps.applyExternalContent(freshContent);
        }
      } catch {
        // Ignore read errors for transient file events.
      }
    }

    await handleExternalFileChange(filename);
    // handleExternalFileChange already applied the single-note cache+index
    // update (with a full-rescan fallback on error), so a coarse
    // scheduleExternalRescan() here is redundant double work (F18 follow-up).
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
      const activeEvent = events.find((ev) => ev.filename === activeFilename);
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

  // ── Live-state handler ──

  /**
   * `sync:live-state` from the Rust live loop. `message` is only present on
   * the error emits: "cycle-error" (a sync cycle failed, stream still up —
   * same failure class as a poll error, so source 'sync') and "reconnecting"
   * (the stream itself is down — source 'stream', cleared only when the
   * stream comes back or the user dismisses, never by a clean poll).
   */
  function handleLiveState(payload: LiveStatePayload): void {
    live = payload.live;
    if (payload.message) {
      raiseSyncError(payload.message, payload.status === 'cycle-error' ? 'sync' : 'stream');
    } else if (payload.live) {
      // Clean (re)connect — a stream error is resolved.
      clearSyncError('stream');
    }
  }

  // ── Sync complete handler ──

  async function handleSyncComplete(summary: SyncSummary, trigger?: SyncTrigger): Promise<void> {
    // Single reporter for sync-completion feedback (spec: sync.md). A cycle
    // with zero per-item failures clears any prior error so the status-bar
    // indicator and Settings stop showing a stale failure — and, for a MANUAL
    // sync (Settings Connect / "Sync now"), toasts "Sync complete" (never
    // per-item success counts — spec decision 2026-06-10; background/live
    // cycles stay quiet). A cycle that COMPLETED but had per-item failures
    // (uploads/deletes that didn't reach the server — work-item #10) raises
    // the muted failure indicator + toast instead — resolution alone is not
    // success.
    if (summary.failureMessage) {
      raiseSyncError(summary.failureMessage);
    } else {
      clearSyncError('sync');
      if (trigger === 'manual') deps.showToast('Sync complete');
    }
    // Stamp the "last synced" time. Nothing else writes appState.lastSyncedAt,
    // so without this the Settings "Last sync" label stayed frozen (e.g.
    // "1mo ago") even after a successful manual "Sync now". Fire it before the
    // first await below: saveAppState updates its in-memory cache synchronously,
    // so handleSyncNow's getCachedPreferences() read (right after the
    // un-awaited onSyncComplete returns) sees the fresh value.
    void updateAppState({ lastSyncedAt: Date.now() }).catch((err) => {
      // Non-critical (the in-memory cache is already updated synchronously), but
      // don't let a rejected appState write become an unhandled rejection /
      // crash report — log it so a genuine persistence failure is still visible.
      console.warn('Failed to persist lastSyncedAt:', err);
    });
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
      deps.onAnySyncRename?.(rename.fromId, rename.toId);
      // Sync writes are Rust-side and their watcher echo is suppressed, so the
      // Tantivy engine never sees them (MiniSearch is refreshed by the rescan
      // below). Reindex peer changes into the engine here — mirrors the native
      // shells' rescan-on-pull. Pure channel sends; the engine coalesces them
      // into one commit. `engineNotify` no-ops off-Tauri.
      void engineNotify('rename', `${rename.toId}.md`, `${rename.fromId}.md`);
    }
    if (hasPeerNoteChanges) {
      for (const id of summary.peerUpdatedIds) void engineNotify('change', `${id}.md`);
      for (const id of summary.peerDeletedIds) void engineNotify('unlink', `${id}.md`);
      setTimeout(() => runExternalRescan(), 50);
    }

    const originalId = deps.getOriginalId();

    const activeRename = originalId ? findActiveSyncRename(summary, originalId) : null;
    if (activeRename) {
      applyActiveRename(activeRename.fromId, activeRename.toId);
      if (
        !summary.renamed.some(
          (rename) => rename.fromId === activeRename.fromId && rename.toId === activeRename.toId,
        )
      ) {
        writeSuppressor.recordRemoteRename(activeRename.fromId, activeRename.toId);
      }
    }

    // Reload only when sync actually touched the currently-open note.
    const currentOriginalId = deps.getOriginalId();
    const openDeleted = !!currentOriginalId && summary.deletedIds.includes(currentOriginalId);
    const openUpdated = !!currentOriginalId && summary.updatedIds.includes(currentOriginalId);
    // The id of the open note whose unsaved draft we deliberately keep open
    // (edit-wins); it must be excluded from tab pruning below.
    let keptDeletedDraftId: string | null = null;
    if (currentOriginalId && (openDeleted || openUpdated)) {
      // W1: `updatedIds` is NOT evidence the open note survived — it aggregates
      // push AND pull, so it also contains ids WE uploaded this cycle. A peer
      // can tombstone note X while this same cycle pushed our edit to X: X lands
      // in both lists yet the pull deleted the file from disk. Ask the
      // filesystem authoritatively instead. If a note deleted this cycle is gone
      // from disk, the tombstone won (close/keep-draft); if it is present, it
      // was recreated and we adopt the on-disk content.
      const openNoteGone = openDeleted && !(await noteExists(currentOriginalId));
      // The existence read above is the only await before the close decision, so
      // re-verify the open note didn't change under us (a local rename racing
      // readNote/noteExists) — the old id is no longer open, nothing to do.
      if (deps.getOriginalId() === currentOriginalId) {
        if (openNoteGone) {
          // F4: a peer deleted the currently-open note and it is gone from disk.
          // read_note returns "" for a missing file on Tauri (crud.rs scan-time
          // tolerance — the contract stays ""), so feeding this id into the adopt
          // path would blank the editor while the session stayed bound to the
          // deleted id; the next keystroke would re-create the file and undo the
          // peer's delete fleet-wide. Never adopt "" — mirror the local-watcher
          // unlink-of-open-note path: keep an unsaved draft, otherwise close.
          // (hasOpenDraftChanges → cancelAndClear stays await-free so a keystroke
          // can't slip in between the check and the close.)
          if (deps.hasOpenDraftChanges()) {
            keptDeletedDraftId = currentOriginalId;
            deps.showToast('Open note was deleted during sync; keeping local draft');
            await refreshNotesFromStorage();
          } else {
            deps.cancelAndClear();
            deps.showToast('Note was deleted during sync');
          }
        } else {
          // The open note was updated, or was deleted-then-recreated on disk —
          // either way it exists, so adopt its on-disk content.
          try {
            const freshContent = await readNote(currentOriginalId);
            if (freshContent !== deps.getEditorContent()) {
              const editedDuringSync =
                deps.getEditVersion() !== (syncCoord?.getSyncStartEditVersion() ?? 0);
              // hasOpenDraftChanges reads the LIVE editor doc synchronously, so it
              // also catches a keystroke whose rAF-coalesced onchange hasn't
              // delivered yet (editVersion not bumped) — without it, the adopt
              // below would replace the doc and silently swallow that keystroke.
              // Also defer the adopt while the editor is focused — replacing the
              // open doc under CM6's live selection/measure state crashes it (see
              // the watcher guard above); the metadata refresh below still runs.
              if (!editedDuringSync && !deps.hasOpenDraftChanges()) {
                if (deps.isEditorFocused()) {
                  deferExternalAdopt(currentOriginalId, freshContent);
                } else {
                  deps.applyExternalContent(freshContent);
                }
              }
            }
            // H13: Always refresh metadata even when content was skipped.
            const meta = getNoteById(currentOriginalId);
            if (meta) {
              deps.applyRemoteRename(currentOriginalId, meta.title);
            }
          } catch {
            // The note exists, so read_note only rejects on a genuine IPC failure
            // — or originalId changed mid-await because a local rename raced.
            // Either way, keep the local draft rather than risk clobbering it.
            if (deps.getOriginalId() !== currentOriginalId) return;
            deps.showToast('Open note changed during sync; keeping local draft');
          }
        }
      }
    }

    // W2: prune any tab still pointing at a note this sync deleted that is now
    // gone from disk, so switching to a background tab — or back to the tab of
    // the note just closed above — can't resurrect it via loadNote reading ""
    // for the missing file. Existence is authoritative (same W1 reason: a
    // deleted id can also be in updatedIds via our own push). A deleted note
    // still on disk was recreated, so it stays. The open note whose unsaved
    // draft we kept is excluded; renames already re-pointed their tabs above.
    const pruneCandidates = summary.deletedIds.filter((id) => id !== keptDeletedDraftId);
    const pruneExistence = await Promise.all(pruneCandidates.map((id) => noteExists(id)));
    const goneIds = pruneCandidates.filter((_, i) => !pruneExistence[i]);
    if (goneIds.length > 0) deps.pruneTabsForDeletedIds?.(goneIds);

    // Sync status banner. A successful sync reports just "Sync complete" —
    // never per-item uploaded/downloaded/deleted/conflict counts (sync.md,
    // 2026-06-10). Only surfaced for large syncs so routine polls stay quiet,
    // and never for a cycle with per-item failures — the ⚠ indicator owns that.
    const totalChanges =
      summary.updatedIds.length + summary.deletedIds.length + summary.renamed.length;
    if (totalChanges > 20 && !summary.failureMessage) {
      syncCoord?.setStatusWithTimeout('Sync complete', 3000);
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
      onSyncComplete: handleSyncComplete,
      onSyncError: (err) => {
        // F15: surface auto/background sync failures in the UI instead of only
        // console.warn — the status-bar indicator + Settings read this state.
        // Edge-triggered toast on the healthy→failing transition; cleared on
        // the next successful sync (handleSyncComplete).
        raiseSyncError(getSyncErrorMessage(err));
        console.warn('Auto-sync error:', err);
      },
      flushPendingSave: deps.flushSave,
      shouldDeferSync: coord.shouldDeferSync,
      onOfflineChange: coord.onOfflineChange,
      onSyncStateChange: coord.onSyncStateChange,
    });

    // Live SSE events from the Rust backend. Guarded on isTauri so non-Tauri
    // environments (web dev, Playwright, jsdom) never touch the Tauri event
    // bridge — hasFileSystem is true in dev-mode web, where listen() throws.
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
      if (externalRescanTimer !== null) {
        clearTimeout(externalRescanTimer);
        externalRescanTimer = null;
      }
      for (const un of liveUnlisteners) un();
      liveUnlisteners = [];
      watcherBatch.destroy();
      syncCoord?.destroy();
    };
  }

  // ── Public API ──

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

    writeSuppressor,
    watcherBatch,

    enqueueFileChange: (event: FileChangeEvent) => watcherBatch.enqueue(event),
    handleEditorFocusChange,
    notifySaved,
    clearSyncError,

    start,
    handleSyncComplete,
    handleFileChange: handleSingleWatcherEvent,
    handleLiveState,
  };
}
