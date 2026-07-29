import {
  getNoteById,
  handleExternalFileChange,
  readNote,
  refreshNotesFromStorage,
} from '$features/notes/notes.svelte';
import type { NoteSession } from '$features/notes/noteSession.svelte';
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
  allowPendingSave?: boolean;
}

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

  async function reconcileOpenNoteFromDisk(
    id: string,
    options: ReconcileOpenNoteOptions,
  ): Promise<boolean> {
    const content = await readNote(id).catch(() => null);
    if (
      content === null ||
      dependencies.session.originalId !== id ||
      (dependencies.session.savePending && !options.allowPendingSave)
    ) {
      return false;
    }

    let storageReconciled = false;
    if (content === '') {
      await handleExternalFileChange(`${id}.md`);
      storageReconciled = true;
      if (
        dependencies.session.originalId !== id ||
        (dependencies.session.savePending && !options.allowPendingSave)
      ) {
        return storageReconciled;
      }
      if (!getNoteById(id)) {
        pendingAdopt = null;
        dependencies.session.cancelAndClear();
        dependencies.showToast('Note was deleted externally');
        return storageReconciled;
      }
    }

    if (content === dependencies.session.savedContent) {
      pendingAdopt = null;
    } else if (dependencies.session.composing) {
      pendingAdopt = id;
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

  async function handleEditorFocusChange(focused: boolean): Promise<void> {
    if (focused || !pendingAdopt) return;

    const id = pendingAdopt;
    pendingAdopt = null;
    if (dependencies.session.originalId !== id) return;
    await reconcileOpenNote(id);
  }

  async function handleFileChange(event: FileChangeEvent): Promise<void> {
    const { type, filename } = event;
    const suppressor = dependencies.writeSuppressor;
    if (!filename.endsWith('.md')) return;

    const id = filename.replace(/\.md$/, '');
    const isActiveNoteChange = type === 'change' && id === dependencies.session.originalId;
    if (
      !isActiveNoteChange &&
      (suppressor.isRecentSyncWrite(filename) || suppressor.isRecentWrite(filename))
    ) {
      return;
    }
    if (type === 'unlink' && suppressor.getRecentRemoteRename(id)) return;

    let storageReconciled = false;
    const activeId = dependencies.session.originalId;
    if (id === activeId && dependencies.session.savePending && type === 'change') return;

    if (type === 'unlink' && id === activeId) {
      pendingAdopt = null;
      dependencies.session.cancelAndClear();
      dependencies.showToast('Note was deleted externally');
    } else if (type === 'change' && id === activeId) {
      storageReconciled = await reconcileOpenNote(id);
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
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = null;
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
    reconcileOpenNote,
    runRescan,
    scheduleRescan,
    stop,
  };
}
