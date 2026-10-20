// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  controlledPromise,
  noteMocks,
  resetCoordinatorMocks,
  syncMocks,
} from './__test__/coordinatorHarness';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';
import { createNoteSession, type NoteSessionDeps } from '$features/notes/noteSession.svelte';
import { createExternalChangeCoordinator } from './createExternalChangeCoordinator';

beforeEach(resetCoordinatorMocks);

// The real note session (save queue + persistence) behind this coordinator,
// over an in-memory vault. `flushDraft` answers as the store's four arms do
// (crates/futo-notes-store flush_draft); classification answers as
// open_note.rs does for the facts these cases reach. Synthetic text only.
const disk = new Map<string, string>();

function park(id: string, content: string): string {
  for (let n = 1; ; n += 1) {
    const copy = n === 1 ? `${id} (conflict)` : `${id} (conflict ${n})`;
    if (disk.get(copy) === content) return copy;
    if (!disk.has(copy)) {
      disk.set(copy, content);
      return copy;
    }
  }
}

function copiesOf(id: string): string[] {
  return [...disk.keys()].filter((key) => key.startsWith(`${id} (conflict`));
}

function openRealSession(id: string, body: string) {
  let editorContent = body;
  const deps: NoteSessionDeps = {
    getEditorContent: () => editorContent,
    setEditorContent: (text) => {
      editorContent = text;
    },
    openEditorNote: (text) => {
      editorContent = text;
    },
    focusEditor: () => {},
    isEditorFocused: () => true,
    isComposing: () => false,
    getNotes: () => [],
    getNoteBody: () => undefined,
    getTitleTextarea: () => undefined,
    getNoteId: () => session.originalId,
    setPrevNoteId: () => {},
    onNoteRenamed: () => {},
    reconcileOpenNote: (noteId, parkedDraft) =>
      coordinator.reconcileOpenNote(noteId, { parkedDraft }),
    navigate: () => {},
  };
  const session = createNoteSession(deps);
  const coordinator = createExternalChangeCoordinator({
    followRename: (fromId, toId) => {
      if (session.originalId === fromId) session.applyRemoteRename(toId, toId);
    },
    session,
    notifySaved: vi.fn(),
    showToast: vi.fn(),
    writeSuppressor: createWriteSuppressor(),
  });
  session.seedOpenNote(id, body);
  return {
    session,
    coordinator,
    type(text: string) {
      editorContent = text;
      session.debouncedSave(text);
    },
  };
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return settled;
}

function installRealVault(): void {
  disk.clear();
  noteMocks.getNoteById.mockImplementation((id: string) =>
    disk.has(id) ? { id, title: id, preview: '', modificationTime: 0, tags: [] } : undefined,
  );
  noteMocks.updateNote.mockImplementation(
    async (id: string, content: string, options: { originalId?: string; base?: string }) => {
      if (options.originalId !== id || options.base === undefined) {
        throw new Error(`unexpected save ${options.originalId} -> ${id}`);
      }
      const current = disk.get(id);
      const result = (disposition: string, parkedId?: string) => ({
        id,
        mtime: 0,
        disposition,
        parkedId,
        unappliedMutation: null,
      });
      if (current === undefined) {
        disk.set(id, content);
        return result('recreated');
      }
      if (current === content) return result('converged');
      if (current === options.base) {
        disk.set(id, content);
        return result('wrote');
      }
      return result('parked', park(id, content));
    },
  );
  syncMocks.classifyOpenNote.mockImplementation(async (facts) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (facts.renamedTo) return { kind: 'followRename', toId: facts.renamedTo };
    const onDisk = disk.get(facts.id);
    const unsaved = facts.draft !== facts.base;
    if (onDisk === undefined) {
      return unsaved
        ? { kind: 'keepDraft', base: facts.base, reason: 'peerDeleted' }
        : { kind: 'close' };
    }
    if (onDisk === facts.draft) {
      return onDisk === facts.base
        ? { kind: 'leave' }
        : { kind: 'keepDraft', base: onDisk, reason: 'converged' };
    }
    if (onDisk === facts.base) return { kind: 'leave' };
    if (unsaved || facts.editedDuringCycle) {
      return { kind: 'keepDraft', base: facts.base, reason: 'diverged' };
    }
    if (facts.editorFocused) return { kind: 'deferAdopt' };
    return { kind: 'adopt', content: onDisk };
  });
}

describe('the real save queue behind the coordinator', () => {
  beforeEach(installRealVault);

  it('a queued reconcile whose save parks does not deadlock the queue', async () => {
    disk.set('Note', 'alpha');
    const h = openRealSession('Note', 'alpha');

    // A non-sync writer edits the open note; its reconcile holds the queue on
    // a slow classification while a second reconcile of the same note queues.
    const classification = controlledPromise<void>();
    const classify = syncMocks.classifyOpenNote.getMockImplementation()!;
    syncMocks.classifyOpenNote.mockImplementationOnce(async (facts) => {
      await classification.promise;
      return classify(facts);
    });
    disk.set('Note', 'alpha edited elsewhere');
    const watcher = h.coordinator.handleFileChange({ type: 'change', filename: 'Note.md' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const queued = h.coordinator.reconcileOpenNote('Note');

    // The user types while both wait; the second finds that save pending, and
    // the save parks, because disk moved under its baseline.
    h.type('alpha plus typing');
    classification.resolve();

    expect(await settlesWithin(Promise.all([watcher, queued]), 300), 'queue wedged').toBe(true);
    expect(copiesOf('Note')).toEqual(['Note (conflict)']);

    // Later typing is an ordinary save of the same continuing edit.
    h.type('alpha plus typing plus more');
    expect(await settlesWithin(h.session.flushSave(), 300), 'save queue wedged').toBe(true);
    expect(copiesOf('Note')).toEqual(['Note (conflict)']);
    expect(disk.get('Note (conflict)')).toBe('alpha plus typing plus more');
    expect(disk.get('Note')).toBe('alpha edited elsewhere');
    h.coordinator.stop();
  });

  it('follows a host rename of the open note before its pending save lands', async () => {
    disk.set('Draft', 'draft text');
    const h = openRealSession('Draft', 'draft text');

    h.type('draft text, typed on');
    disk.delete('Draft');
    disk.set('Draft renamed', 'draft text');
    await h.coordinator.handleFileChange({
      type: 'rename',
      from: 'Draft.md',
      filename: 'Draft renamed.md',
    });
    await h.session.flushSave();

    expect(h.session.originalId).toBe('Draft renamed');
    expect(disk.has('Draft'), 'a ghost recreated at the pre-rename id').toBe(false);
    expect(disk.get('Draft renamed')).toBe('draft text, typed on');
    expect(copiesOf('Draft renamed')).toEqual([]);
    h.coordinator.stop();
  });
});
