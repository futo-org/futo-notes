import { handleExternalFileChange, refreshNotesFromStorage } from '$features/notes/notes.svelte';
import type { NoteSession, ParkedDraftSnapshot } from '$features/notes/noteSession.svelte';
import { hasFileSystem } from '$lib/platform';
import type { FileChangeEvent } from '$lib/platform/types';
import {
  classifyOpenNote,
  type OpenNoteDispositionOutput,
  type OpenNoteRequestInput,
} from './syncServiceE2ee';
import { createWatcherBatch } from './watcherBatch';
import type { WriteSuppressor } from '$lib/platform/writeSuppression';

interface ExternalChangeDependencies {
  followRename: (fromId: string, toId: string) => void;
  session: NoteSession;
  notifySaved: () => void;
  showToast: (message: string) => void;
  writeSuppressor: WriteSuppressor;
}

export interface ReconcileOpenNoteOptions {
  editedDuringCycle?: boolean;
  parkedDraft?: ParkedDraftSnapshot;
  renamedTo?: string | null;
}

export interface OpenNoteReconcileResult {
  disposition: OpenNoteDispositionOutput['kind'] | null;
  followedRenameTo: string | null;
  keptDraftId: string | null;
  stale: boolean;
}

interface EditorSnapshot {
  base: string;
  draft: string;
  editVersion: number;
  focused: boolean;
  id: string;
  title: string;
}

const NO_RECONCILIATION: OpenNoteReconcileResult = {
  disposition: null,
  followedRenameTo: null,
  keptDraftId: null,
  stale: false,
};

// eslint-disable-next-line max-lines-per-function -- One coordinator owns the serialized watcher and engine-verdict lifecycle.
export function createExternalChangeCoordinator(dependencies: ExternalChangeDependencies) {
  let rescanTimer: number | null = null;
  let rescanInFlight = false;
  let rescanQueued = false;
  let pendingReconcile: { id: string; options: ReconcileOpenNoteOptions } | null = null;
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

  function deferReconcile(id: string, options: ReconcileOpenNoteOptions = {}): void {
    pendingReconcile = { id, options };
    scheduleDeferredAdoptSettle();
  }

  function captureEditor(id: string, options: ReconcileOpenNoteOptions): EditorSnapshot | null {
    const session = dependencies.session;
    const draft = session.editorContent;
    if (session.originalId !== id || draft === undefined) return null;
    const parkedDraftStillCurrent =
      options.parkedDraft !== undefined &&
      draft === options.parkedDraft.content &&
      session.title === options.parkedDraft.title;
    return {
      id,
      draft,
      // Once this exact draft was parked, it is safe to adopt the peer's
      // original: the draft already survives at its conflict-copy id.
      base: parkedDraftStillCurrent ? draft : session.savedContent,
      editVersion: session.editVersion,
      focused: session.editorFocused || session.composing,
      title: session.title,
    };
  }

  function editorStillMatches(snapshot: EditorSnapshot): boolean {
    const session = dependencies.session;
    return (
      !disposed &&
      session.originalId === snapshot.id &&
      session.editVersion === snapshot.editVersion &&
      session.editorContent === snapshot.draft &&
      session.title === snapshot.title &&
      (session.editorFocused || session.composing) === snapshot.focused &&
      (session.savedContent === snapshot.base || snapshot.base === snapshot.draft)
    );
  }

  function factsFor(
    snapshot: EditorSnapshot,
    options: ReconcileOpenNoteOptions,
  ): OpenNoteRequestInput {
    return {
      id: snapshot.id,
      base: snapshot.base,
      draft: snapshot.draft,
      renamedTo: options.renamedTo ?? null,
      editorFocused: snapshot.focused,
      editedDuringCycle: options.editedDuringCycle ?? false,
    };
  }

  function applyDisposition(
    id: string,
    disposition: OpenNoteDispositionOutput,
    options: ReconcileOpenNoteOptions,
  ): OpenNoteReconcileResult {
    const result: OpenNoteReconcileResult = {
      disposition: disposition.kind,
      followedRenameTo: null,
      keptDraftId: null,
      stale: false,
    };
    switch (disposition.kind) {
      case 'leave':
        pendingReconcile = null;
        break;
      case 'adopt':
        pendingReconcile = null;
        dependencies.session.applyExternalContent(disposition.content);
        break;
      case 'deferAdopt':
        deferReconcile(id, options);
        break;
      case 'followRename':
        pendingReconcile = null;
        dependencies.followRename(id, disposition.toId);
        result.followedRenameTo = disposition.toId;
        break;
      case 'keepDraft':
        pendingReconcile = null;
        dependencies.session.rebaseSavedContent(disposition.base);
        dependencies.session.resumeDraftPersistence();
        if (disposition.reason === 'peerDeleted') {
          dependencies.showToast('Open note was deleted; keeping local draft');
          result.keptDraftId = id;
        }
        break;
      case 'close':
        pendingReconcile = null;
        dependencies.session.cancelAndClear();
        dependencies.showToast('Note was deleted');
        break;
    }
    return result;
  }

  async function reconcileOpenNoteWithEngine(
    id: string,
    options: ReconcileOpenNoteOptions,
  ): Promise<OpenNoteReconcileResult> {
    if (disposed || dependencies.session.originalId !== id) return NO_RECONCILIATION;
    if (dependencies.session.composing && dependencies.session.savePending) {
      deferReconcile(id, options);
      return NO_RECONCILIATION;
    }
    if (dependencies.session.savePending && options.parkedDraft === undefined) {
      await dependencies.session.flushSave();
      if (disposed || dependencies.session.originalId !== id) return NO_RECONCILIATION;
    }

    const snapshot = captureEditor(id, options);
    if (!snapshot) return NO_RECONCILIATION;
    let disposition: OpenNoteDispositionOutput;
    try {
      disposition = await classifyOpenNote(factsFor(snapshot, options));
    } catch (error) {
      pendingReconcile = { id, options };
      console.warn('Open-note classification failed:', error);
      return { ...NO_RECONCILIATION, keptDraftId: id };
    }
    if (!editorStillMatches(snapshot)) {
      if (dependencies.session.originalId === id) {
        deferReconcile(id, options);
      }
      return { ...NO_RECONCILIATION, keptDraftId: id, stale: true };
    }
    return applyDisposition(id, disposition, options);
  }

  function reconcileOpenNote(
    id: string,
    options: ReconcileOpenNoteOptions = {},
  ): Promise<OpenNoteReconcileResult> {
    const operation = () => reconcileOpenNoteWithEngine(id, options);
    const run = reconciliationTail.then(operation, operation);
    reconciliationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function settleDeferredAdopt(): Promise<void> {
    if (!pendingReconcile || disposed) return;
    const { id, options } = pendingReconcile;
    if (dependencies.session.originalId !== id) {
      pendingReconcile = null;
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
    pendingReconcile = null;
    await reconcileOpenNote(id, options);
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

  async function handleFileChange(event: FileChangeEvent, shouldNotifySaved = true): Promise<void> {
    const { type, filename } = event;
    const suppressor = dependencies.writeSuppressor;
    const session = dependencies.session;

    if (type === 'rename' && event.from) {
      const fromIsNote = event.from.endsWith('.md');
      const toIsNote = filename.endsWith('.md');
      if (fromIsNote && !toIsNote) {
        await handleFileChange({ type: 'unlink', filename: event.from }, shouldNotifySaved);
        return;
      }
      if (!fromIsNote && toIsNote) {
        await handleFileChange({ type: 'add', filename }, shouldNotifySaved);
        return;
      }
      if (!fromIsNote || !toIsNote) return;

      const fromId = event.from.replace(/\.md$/, '');
      const toId = filename.replace(/\.md$/, '');
      if (suppressor.getRecentRemoteRename(fromId)) return;
      if (fromId === session.originalId) {
        await reconcileOpenNote(fromId, { renamedTo: toId });
      }
      await handleExternalFileChange(filename);
      if (shouldNotifySaved) dependencies.notifySaved();
      return;
    }

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

    if (isActiveNoteChange && session.composing) {
      deferReconcile(id);
      await handleExternalFileChange(filename);
      if (shouldNotifySaved) dependencies.notifySaved();
      return;
    }
    if (isActiveNoteChange) {
      await session.flushSave();
    }
    if (type === 'unlink' && id === session.originalId) {
      await reconcileOpenNote(id);
    } else if (isActiveNoteChange) {
      await reconcileOpenNote(id);
    }

    await handleExternalFileChange(filename);
    if (shouldNotifySaved && (type === 'add' || type === 'change')) dependencies.notifySaved();
  }

  async function handleBulkRefresh(events: FileChangeEvent[]): Promise<void> {
    scheduleRescan(250);
    const suppressor = dependencies.writeSuppressor;
    const activeFilenames = new Set<string>();
    for (const event of events) {
      const activeId = dependencies.session.originalId;
      if (activeId === null) continue;
      const activeFilename = `${activeId}.md`;
      activeFilenames.add(activeFilename);
      if (
        event.filename === activeFilename ||
        (event.type === 'rename' && event.from === activeFilename)
      ) {
        await handleFileChange(event, false);
      }
    }

    const shouldNotifySaved = events.some((event) => {
      if (event.type !== 'add' && event.type !== 'change' && event.type !== 'rename') return false;
      if (event.type === 'change' && activeFilenames.has(event.filename)) return true;
      if (suppressor.isRecentSyncWrite(event.filename)) return false;
      if (event.type !== 'rename') return true;
      if (!event.filename.endsWith('.md')) return false;
      if (!event.from?.endsWith('.md')) return true;
      const fromId = event.from.replace(/\.md$/, '');
      return suppressor.getRecentRemoteRename(fromId) === null;
    });
    if (shouldNotifySaved) dependencies.notifySaved();
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
    pendingReconcile = null;
    watcherBatch.destroy();
  }

  return {
    watcherBatch,
    handleFileChange,
    handleEditorFocusChange,
    handleCompositionEnd,
    reconcileOpenNote,
    runRescan,
    scheduleRescan,
    stop,
  };
}
