import {
  getNoteById,
  handleExternalFileChange,
  readNote,
  refreshNotesFromStorage,
} from '$features/notes/notes.svelte';
import type { NoteSession, ParkedDraftSnapshot } from '$features/notes/noteSession.svelte';
import { hasFileSystem } from '$lib/platform';
import type { FileChangeEvent } from '$lib/platform/types';
import { createWatcherBatch } from './watcherBatch';
import type { WriteSuppressor } from '$lib/platform/writeSuppression';

interface ExternalChangeDependencies {
  session: NoteSession;
  notifySaved: () => void;
  showToast: (message: string) => void;
  writeSuppressor: WriteSuppressor;
}

interface ReconcileOpenNoteOptions {
  parkedDraft?: ParkedDraftSnapshot;
}

type ReconcileDropReason = 'identity' | 'save-pending' | null;

function reconcileDropReason(
  session: NoteSession,
  id: string,
  options: ReconcileOpenNoteOptions,
): ReconcileDropReason {
  if (session.originalId !== id) return 'identity';
  if (session.savePending && options.parkedDraft === undefined) return 'save-pending';
  return null;
}

// eslint-disable-next-line max-lines-per-function -- One coordinator owns the serialized watcher, flush, and deferred-adopt lifecycle.
export function createExternalChangeCoordinator(dependencies: ExternalChangeDependencies) {
  let rescanTimer: number | null = null;
  let rescanInFlight = false;
  let rescanQueued = false;
  let pendingAdopt: string | null = null;
  let reconciliationTail: Promise<void> = Promise.resolve();

  async function runRescan(): Promise<void> {
    if (!hasFileSystem) return;
    if (rescanInFlight) {
      rescanQueued = true;
      return;
    }
    rescanInFlight = true;
    try {
      await refreshNotesFromStorage();
    } catch (error) {
      console.warn('External rescan failed:', error);
    } finally {
      rescanInFlight = false;
      if (rescanQueued) {
        rescanQueued = false;
        scheduleRescan(250);
      }
    }
  }

  function scheduleRescan(delay = 800): void {
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      void runRescan();
    }, delay);
  }

  function dropOrDeferReconcile(id: string, options: ReconcileOpenNoteOptions): boolean {
    if (disposed) return true;
    const reason = reconcileDropReason(dependencies.session, id, options);
    if (reason === 'save-pending') {
      // A save that started mid-read owns the next disk state; keep the adopt
      // deferred so a later settle edge re-drives it instead of dropping it.
      pendingAdopt = id;
      scheduleDeferredAdoptSettle();
    }
    return reason !== null;
  }

  async function reconcileOpenNoteFromDisk(
    id: string,
    options: ReconcileOpenNoteOptions,
  ): Promise<boolean> {
    let content = await readNote(id).catch(() => null);
    if (content === null || dropOrDeferReconcile(id, options)) {
      return false;
    }

    let storageReconciled = false;
    if (content === '') {
      await handleExternalFileChange(`${id}.md`);
      storageReconciled = true;
      if (dropOrDeferReconcile(id, options)) {
        return storageReconciled;
      }
      if (!getNoteById(id)) {
        pendingAdopt = null;
        dependencies.session.cancelAndClear();
        dependencies.showToast('Note was deleted externally');
        return storageReconciled;
      }
      content = await readNote(id).catch(() => null);
      if (content === null || dropOrDeferReconcile(id, options)) {
        return storageReconciled;
      }
    }

    const canAdoptParkedDraft =
      options.parkedDraft !== undefined &&
      dependencies.session.editorContent === options.parkedDraft.content &&
      dependencies.session.title === options.parkedDraft.title;
    if (content === dependencies.session.savedContent) {
      pendingAdopt = null;
    } else if (
      dependencies.session.composing ||
      (dependencies.session.dirty && !canAdoptParkedDraft)
    ) {
      pendingAdopt = id;
      scheduleDeferredAdoptSettle();
    } else {
      pendingAdopt = null;
      dependencies.session.applyExternalContent(content);
    }
    return storageReconciled;
  }

  function reconcileOpenNote(id: string, options: ReconcileOpenNoteOptions = {}): Promise<boolean> {
    const operation = () => reconcileOpenNoteFromDisk(id, options);
    const run = reconciliationTail.then(operation, operation);
    reconciliationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function settleDeferredAdopt(): Promise<void> {
    if (!pendingAdopt || disposed) return;
    const id = pendingAdopt;
    if (dependencies.session.originalId !== id) {
      pendingAdopt = null;
      return;
    }
    // Never flush mid-composition (a blur can precede compositionend, and
    // CodeMirror can still report composing when compositionend fires): retain
    // the deferral and recheck shortly so it cannot be stranded. Bounded — a
    // composing flag stuck past the retry budget parks the deferral until the
    // next real blur/compositionend edge (which resets the budget).
    if (dependencies.session.composing) {
      if (compositionRetries < MAX_COMPOSITION_RETRIES && settleTimer === null) {
        compositionRetries += 1;
        settleTimer = setTimeout(() => {
          settleTimer = null;
          void settleDeferredAdopt();
        }, 50);
      }
      return;
    }
    compositionRetries = 0;
    await dependencies.session.flushSave();
    if (disposed) return;
    if (dependencies.session.originalId !== id || dependencies.session.dirty) return;
    pendingAdopt = null;
    await reconcileOpenNote(id);
  }

  // A deferral assigned while the editor is already blurred and not composing
  // has no future blur/composition-end edge to settle it — run one settle pass
  // after the current operation finishes. Coalesced: a settle that stays dirty
  // keeps the deferral for the next edge, and re-arming requires a fresh
  // assignment, so an idle session cannot timer-spin.
  let settleTimer: number | null = null;
  let disposed = false;
  const MAX_COMPOSITION_RETRIES = 10;
  let compositionRetries = 0;
  function scheduleDeferredAdoptSettle(): void {
    if (settleTimer !== null || disposed) return;
    if (dependencies.session.editorFocused || dependencies.session.composing) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void settleDeferredAdopt();
    }, 0);
  }

  async function handleEditorFocusChange(focused: boolean): Promise<void> {
    if (!focused) {
      compositionRetries = 0;
      await settleDeferredAdopt();
    }
  }

  async function handleCompositionEnd(): Promise<void> {
    // settleDeferredAdopt self-guards while composing is still reported and
    // rechecks shortly, so a compositionend that outruns the editor's
    // composing flag cannot strand the deferral.
    compositionRetries = 0;
    await settleDeferredAdopt();
  }

  async function handleFileChange(event: FileChangeEvent): Promise<void> {
    const { type, filename } = event;
    const suppressor = dependencies.writeSuppressor;
    const session = dependencies.session;
    if (!filename.endsWith('.md')) return;

    const id = filename.replace(/\.md$/, '');
    const isActiveNoteChange = type === 'change' && id === session.originalId;
    if (
      !isActiveNoteChange &&
      (suppressor.isRecentSyncWrite(filename) || suppressor.isRecentWrite(filename))
    ) {
      return;
    }
    if (type === 'unlink' && suppressor.getRecentRemoteRename(id)) return;

    let storageReconciled = false;
    if (isActiveNoteChange && session.composing) {
      pendingAdopt = id;
      await handleExternalFileChange(filename);
      dependencies.notifySaved();
      return;
    }
    if (isActiveNoteChange) {
      await session.flushSave();
    }
    const keepPendingDraft = isActiveNoteChange && session.originalId === id && session.dirty;
    if (type === 'unlink' && id === session.originalId) {
      pendingAdopt = null;
      dependencies.session.cancelAndClear();
      dependencies.showToast('Note was deleted externally');
    } else if (isActiveNoteChange) {
      if (keepPendingDraft) {
        pendingAdopt = id;
        scheduleDeferredAdoptSettle();
      } else {
        storageReconciled = await reconcileOpenNote(id);
      }
    }

    if (!storageReconciled) await handleExternalFileChange(filename);
    if (type === 'add' || type === 'change') dependencies.notifySaved();
  }

  async function handleBulkRefresh(events: FileChangeEvent[]): Promise<void> {
    scheduleRescan(250);
    const activeId = dependencies.session.originalId;
    if (!activeId) return;

    const activeEvent = events.find((event) => event.filename === `${activeId}.md`);
    if (activeEvent) await handleFileChange(activeEvent);
  }

  const watcherBatch = createWatcherBatch({
    onEvent: handleFileChange,
    onBulkRefresh: handleBulkRefresh,
    suppressor: dependencies.writeSuppressor,
    isDrainExempt: (event) =>
      event.type === 'change' &&
      dependencies.session.originalId !== null &&
      event.filename === `${dependencies.session.originalId}.md`,
  });

  function stop(): void {
    disposed = true;
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = null;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    pendingAdopt = null;
    watcherBatch.destroy();
  }

  function deferAdopt(id: string): void {
    pendingAdopt = id;
  }

  return {
    watcherBatch,
    deferAdopt,
    handleFileChange,
    handleEditorFocusChange,
    handleCompositionEnd,
    reconcileOpenNote,
    runRescan,
    scheduleRescan,
    stop,
  };
}
