import {
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

export function createExternalChangeCoordinator(dependencies: ExternalChangeDependencies) {
  let rescanTimer: number | null = null;
  let rescanInFlight = false;
  let rescanQueued = false;
  let pendingAdopt: { id: string; content: string } | null = null;

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

  async function preserveLocalDraft(): Promise<void> {
    dependencies.showToast('Open note changed externally; keeping local draft');
    await refreshNotesFromStorage();
    scheduleRescan(250);
  }

  async function handleEditorFocusChange(focused: boolean): Promise<void> {
    if (focused || !pendingAdopt) return;

    const pending = pendingAdopt;
    pendingAdopt = null;
    if (dependencies.session.originalId !== pending.id) return;
    if (pending.content === dependencies.session.editorContent) return;
    if (dependencies.session.dirty) {
      await preserveLocalDraft();
    } else {
      dependencies.session.applyExternalContent(pending.content);
    }
  }

  async function handleFileChange(event: FileChangeEvent): Promise<void> {
    const { type, filename } = event;
    const suppressor = dependencies.writeSuppressor;
    if (!filename.endsWith('.md')) return;
    if (suppressor.isRecentSyncWrite(filename) || suppressor.isRecentWrite(filename)) return;

    const id = filename.replace(/\.md$/, '');
    if (type === 'unlink' && suppressor.getRecentRemoteRename(id)) return;

    const activeId = dependencies.session.originalId;
    if (id === activeId && dependencies.session.savePending && type === 'change') return;
    if (id === activeId && dependencies.session.dirty && (type === 'change' || type === 'unlink')) {
      if (type === 'unlink') {
        dependencies.showToast('Open note was deleted externally; keeping local draft');
        await refreshNotesFromStorage();
      } else {
        await preserveLocalDraft();
      }
      return;
    }

    if (type === 'unlink' && id === activeId) {
      dependencies.session.cancelAndClear();
      dependencies.showToast('Note was deleted externally');
    } else if (type === 'change' && id === activeId) {
      const content = await readNote(id).catch(() => null);
      if (content !== null) {
        // Replacing a focused CM6 document can corrupt an active selection or IME session.
        if (dependencies.session.editorFocused) {
          pendingAdopt = { id, content };
        } else {
          dependencies.session.applyExternalContent(content);
        }
      }
    }

    await handleExternalFileChange(filename);
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
  });

  function stop(): void {
    if (rescanTimer !== null) clearTimeout(rescanTimer);
    rescanTimer = null;
    watcherBatch.destroy();
  }

  function deferAdopt(id: string, content: string): void {
    pendingAdopt = { id, content };
  }

  return {
    watcherBatch,
    deferAdopt,
    handleFileChange,
    handleEditorFocusChange,
    runRescan,
    scheduleRescan,
    stop,
  };
}
