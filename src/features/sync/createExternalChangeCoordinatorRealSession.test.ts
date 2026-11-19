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
// over an in-memory vault. The editor's host saves as an attachment's
// checkpoint does (crates/futo-notes-store editor_session/checkpoint.rs over
// flush_draft's four arms); classification answers as open_note.rs does for
// the facts these cases reach. Synthetic text only.
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

type Disposition = 'wrote' | 'converged' | 'recreated' | 'parked';

/** flush_draft: write `content` at `id` when disk still holds `base`, else park it. */
function flushDraft(id: string, base: string, content: string): [Disposition, string] {
  const current = disk.get(id);
  if (current === undefined) {
    disk.set(id, content);
    return ['recreated', id];
  }
  if (current === content) return ['converged', id];
  if (current === base) {
    disk.set(id, content);
    return ['wrote', id];
  }
  return ['parked', park(id, content)];
}

function openRealSession(id: string, body: string) {
  let editorContent = body;
  // The editor's host: the attached note, and the base it last loaded or wrote.
  let hostId = id;
  let hostBase = body;
  const readBack = (): void => {
    editorContent = disk.get(hostId) ?? '';
    hostBase = editorContent;
  };
  const deps: NoteSessionDeps = {
    getEditorContent: () => editorContent,
    getEditorSavedSource: () => hostBase,
    getEditorNoteId: () => hostId,
    isEditorIdle: () => editorContent === hostBase,
    reloadEditorNote: readBack,
    takeOutsideEditorChange: readBack,
    openEditorNote: (noteId) => {
      if (noteId !== null) hostId = noteId;
      editorContent = noteId === null ? '' : (disk.get(noteId) ?? '');
      hostBase = editorContent;
    },
    saveEditorNote: async () => {
      if (editorContent === hostBase) return;
      const [disposition, savedId] = flushDraft(hostId, hostBase, editorContent);
      hostBase = editorContent;
      // The attachment retargets to a copy it parked, and the editor reports both at once.
      if (disposition === 'parked') {
        const fromId = hostId;
        hostId = savedId;
        session.followEditorNote(fromId, savedId, true);
      }
      if (disposition !== 'converged') session.editorSaved();
    },
    renameEditorNote: async (wantedId) => {
      throw new Error(`unexpected move ${hostId} -> ${wantedId}`);
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
    navigate: () => {},
  };
  const session = createNoteSession(deps);
  const coordinator = createExternalChangeCoordinator({
    session,
    notifySaved: vi.fn(),
    showToast: vi.fn(),
    writeSuppressor: createWriteSuppressor(),
  });
  session.seedOpenNote(id);
  return {
    session,
    coordinator,
    /** The watcher's sink: the store moves the attachment, and the host reports it. */
    watcherRenamed(fromId: string, toId: string) {
      if (hostId !== fromId || disk.has(fromId)) return;
      hostId = toId;
      session.followEditorNote(fromId, toId, false);
    },
    type(text: string) {
      editorContent = text;
      session.editorEdited();
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

  it('follows a rename made outside the app before its pending save lands', async () => {
    disk.set('Draft', 'draft text');
    const h = openRealSession('Draft', 'draft text');

    h.type('draft text, typed on');
    disk.delete('Draft');
    disk.set('Draft renamed', 'draft text');
    h.watcherRenamed('Draft', 'Draft renamed');
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
