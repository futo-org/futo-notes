import { handleExternalFileChange, refreshNotesFromStorage } from '$features/notes/notes.svelte';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { hasFileSystem } from '$lib/platform';
import type { FileChangeEvent } from '$lib/platform/types';
import {
  classifyOpenNote,
  type OpenNoteDispositionOutput,
  type OpenNoteRequestInput,
} from './syncServiceE2ee';
import { createWatcherBatch } from './watcherBatch';
import type { WriteSuppressor } from '$lib/platform/writeSuppression';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';

interface ExternalChangeDependencies {
  session: NoteSession;
  notifySaved: () => void;
  showToast: (message: ToastMessage) => void;
  writeSuppressor: WriteSuppressor;
}

export interface ReconcileOpenNoteOptions {
  editedDuringCycle?: boolean;
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

/** A queued operation found a save pending; settle it outside the queue. */
const SETTLE_SAVE_FIRST = Symbol('settleSaveFirst');

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

  function captureEditor(id: string): EditorSnapshot | null {
    const session = dependencies.session;
    const draft = session.editorContent;
    if (session.originalId !== id || draft === undefined) return null;
    return {
      id,
      draft,
      base: session.savedContent,
      editVersion: session.editVersion,
      focused: session.composing,
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
      session.composing === snapshot.focused &&
      session.savedContent === snapshot.base
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
      // The store moved the editor's attachment with the note and the session follows
      // the editor (`onnote`); the caller goes on to the note it went to.
      case 'followRename':
        pendingReconcile = null;
        result.followedRenameTo = disposition.toId;
        break;
      // The baseline is the editor host's own: its next save writes the draft, parks it
      // against a changed note, or recreates a deleted one, and the session's baseline
      // follows what it saved. `disposition.base` is that same baseline, or the draft
      // when disk already holds it as saved (converged), which that save then records.
      case 'keepDraft':
        pendingReconcile = null;
        dependencies.session.resumeDraftPersistence();
        if (disposition.reason === 'peerDeleted') {
          dependencies.showToast({ path: 'notes.save.openNoteDeletedKeepingDraft' });
          result.keptDraftId = id;
        }
        break;
      case 'close':
        pendingReconcile = null;
        dependencies.session.cancelAndClear();
        dependencies.showToast({ path: 'notes.deletedElsewhere' });
        break;
    }
    return result;
  }

  async function reconcileOpenNoteWithEngine(
    id: string,
    options: ReconcileOpenNoteOptions,
    saveSettled: boolean,
  ): Promise<OpenNoteReconcileResult | typeof SETTLE_SAVE_FIRST> {
    if (disposed || dependencies.session.originalId !== id) return NO_RECONCILIATION;
    // A pending save settles first. It cannot recreate a note a relocation left: the
    // store moved the editor's attachment with the note (a sync relocation, a rename
    // the file watcher saw), so the save lands where the note went (sync.md, "the
    // editor never stays bound to the deleted id").
    if (dependencies.session.composing && dependencies.session.savePending) {
      deferReconcile(id, options);
      return NO_RECONCILIATION;
    }
    if (!saveSettled && dependencies.session.savePending) return SETTLE_SAVE_FIRST;

    const snapshot = captureEditor(id);
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

  // A queued operation never awaits the save queue: one that finds a save
  // pending gives the queue up, settles the save outside it, then queues once
  // more, so no other reconciliation waits behind that save.
  function reconcileOpenNote(
    id: string,
    options: ReconcileOpenNoteOptions = {},
    saveSettled = false,
  ): Promise<OpenNoteReconcileResult> {
    const operation = () => reconcileOpenNoteWithEngine(id, options, saveSettled);
    const run = reconciliationTail.then(operation, operation);
    reconciliationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(async (result) => {
      if (result !== SETTLE_SAVE_FIRST) return result;
      await dependencies.session.flushSave();
      if (disposed || dependencies.session.originalId !== id) return NO_RECONCILIATION;
      return reconcileOpenNote(id, options, true);
    });
  }

  async function settleDeferredAdopt(): Promise<void> {
    if (!pendingReconcile || disposed) return;
    const { id, options } = pendingReconcile;
    if (dependencies.session.originalId !== id) {
      pendingReconcile = null;
      return;
    }
    // Never flush mid-composition (a blur can precede compositionend): retain
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
    if (dependencies.session.composing) return;
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
      // A rename onto the open note (an atomic save through a temp file with
      // a note's name) replaced its bytes: re-read it like an edit.
      if (toId === session.originalId) {
        await handleFileChange({ type: 'change', filename }, shouldNotifySaved);
        return;
      }
      // The store moved the editor's attachment as the watcher reported this
      // (`observe_external_change`) and the session follows the editor: there is
      // nothing to ask, and a reconcile deferred for the old id is moot.
      if (pendingReconcile?.id === fromId) pendingReconcile = null;
      await handleExternalFileChange(filename);
      if (shouldNotifySaved) dependencies.notifySaved();
      return;
    }

    if (!filename.endsWith('.md')) return;

    const id = filename.replace(/\.md$/, '');
    // An add of the open note is an atomic save through a hidden temp file
    // (Linux inotify reports the temp's rename that way): new bytes, too.
    const isActiveNoteChange = (type === 'change' || type === 'add') && id === session.originalId;
    if (!isActiveNoteChange && suppressor.isRecentSyncWrite(filename)) {
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
    stop,
  };
}
