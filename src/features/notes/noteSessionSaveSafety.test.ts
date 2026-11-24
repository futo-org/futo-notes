// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './__test__/noteSessionMocks';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';
import { createExternalChangeCoordinator } from '$features/sync/createExternalChangeCoordinator';
import { notifySaved } from '$features/sync/autoSync';
import { typeTitle } from './__test__/typeTitle';
import { createFakeEditor, sessionOver, type FakeEditor } from './__test__/fakeEditor';

let editor: FakeEditor;

beforeEach(() => {
  editor = createFakeEditor(
    new Map([
      ['A', 'A body'],
      ['B', 'B body'],
      ['Scratch', 'base\n'],
    ]),
  );
  vi.mocked(notifySaved).mockClear();
});

describe('external unlink during an in-flight rename', () => {
  it("does not clear the rename's identity", async () => {
    const { session, deps } = sessionOver(editor);
    session.seedOpenNote('A');
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const rename = deps.renameEditorNote.getMockImplementation()!;
    deps.renameEditorNote.mockImplementationOnce(async (wantedId) => {
      await renameGate;
      await rename(wantedId);
    });
    typeTitle(session, 'Renamed');
    const renaming = session.flushSave();
    await vi.waitFor(() => expect(deps.renameEditorNote).toHaveBeenCalledOnce());

    const externalChanges = createExternalChangeCoordinator({
      session,
      notifySaved: vi.fn(),
      showToast: vi.fn(),
      writeSuppressor: createWriteSuppressor(),
    });
    const handlingUnlink = externalChanges.handleFileChange({ type: 'unlink', filename: 'A.md' });
    await Promise.resolve();
    expect(session.originalId).toBe('A');

    releaseRename();
    await Promise.all([renaming, handlingUnlink]);

    expect(session.originalId).toBe('Renamed');
    expect(session.title).toBe('Renamed');
    expect(deps.onNoteRenamed).toHaveBeenCalledExactlyOnceWith('A', 'Renamed');
    expect(notifySaved).toHaveBeenCalledOnce();
    expect(deps.renameEditorNote).toHaveBeenCalledOnce();
    expect(session.savePending).toBe(false);
    externalChanges.stop();
  });
});

describe('a park while a rename runs', () => {
  it("ends on the rename's final id", async () => {
    const { session, deps } = sessionOver(editor);
    session.seedOpenNote('A');
    editor.type('A draft');
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const rename = deps.renameEditorNote.getMockImplementation()!;
    deps.renameEditorNote.mockImplementationOnce(async (wantedId) => {
      await renameGate;
      await rename(wantedId);
    });

    typeTitle(session, 'W');
    const renaming = session.flushSave();
    // The host's timer parks the draft before the rename runs; the rename then
    // saves the copy as W (editor_rename on the attachment that now holds the copy).
    editor.park('A (conflict)');
    expect(session.originalId).toBe('A (conflict)');
    releaseRename();
    await renaming;

    expect(session.originalId).toBe('W');
    expect(session.title).toBe('W');
    expect(editor.noteId).toBe('W');
    expect(deps.onNoteRenamed.mock.calls).toEqual([
      [null, 'A (conflict)'],
      ['A (conflict)', 'W'],
    ]);
    expect(session.dirty).toBe(false);
  });
});

describe('a note switch while the outgoing note is still being typed in', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves the late edit to the outgoing note, never to the note being opened', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    let routeNoteId: string | null = 'A';
    const { session, deps } = sessionOver(editor, { getNoteId: () => routeNoteId });
    session.seedOpenNote('A');
    editor.type('A body v2');
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = deps.saveEditorNote.getMockImplementation()!;
    deps.saveEditorNote.mockImplementationOnce(async () => {
      await saveGate;
      await save();
    });

    routeNoteId = 'B';
    const opening = session.loadNote('B');
    // A keystroke lands while the switch's flush is still saving.
    editor.type('A body v3 (typed during the flush)');
    releaseSave();
    await opening;
    vi.unstubAllGlobals();

    // The editor's close wrote it, before B was opened.
    expect(editor.disk.get('A')).toBe('A body v3 (typed during the flush)');
    expect(editor.disk.get('B')).toBe('B body');
    expect(session.originalId).toBe('B');
    expect(session.editorContent).toBe('B body');
  });
});

describe('what the editor holds is what saves', () => {
  it('empties a note the user cleared', async () => {
    const { session, deps } = sessionOver(editor);
    session.seedOpenNote('Scratch');

    editor.type('');
    await session.flushSave();

    expect(deps.saveEditorNote).toHaveBeenCalledOnce();
    expect(session.savedContent).toBe('');
  });

  it('advances its baseline from a save the host made on its own', () => {
    const { session, deps } = sessionOver(editor);
    session.seedOpenNote('Scratch');
    editor.type('typed\n');
    expect(session.dirty).toBe(true);

    editor.hostSave();

    expect(session.savedContent).toBe('typed\n');
    expect(session.dirty).toBe(false);
    expect(notifySaved).toHaveBeenCalledOnce();
    expect(deps.saveEditorNote).not.toHaveBeenCalled();
  });

  it('keeps its baseline when a save landed with an edit still in flight', () => {
    const { session } = sessionOver(editor);
    session.seedOpenNote('Scratch');
    editor.type('typed\n');

    session.editorSaved(null);

    expect(session.savedContent).toBe('base\n');
    expect(session.dirty).toBe(true);
  });

  it('follows a parked copy with the parked draft as its baseline, moving the active tab', () => {
    const { session, deps } = sessionOver(editor);
    session.seedOpenNote('Scratch');
    editor.type('my draft\n');

    editor.park('Scratch (conflict 2026-11-03)');

    expect(session.originalId).toBe('Scratch (conflict 2026-11-03)');
    expect(session.title).toBe('Scratch (conflict 2026-11-03)');
    expect(session.savedContent).toBe('my draft\n');
    expect(session.dirty).toBe(false);
    expect(deps.onNoteRenamed).toHaveBeenCalledExactlyOnceWith(
      null,
      'Scratch (conflict 2026-11-03)',
    );
  });

  it('keeps an unsaved typed title through a park, and ignores a park of a note it left', () => {
    const { session } = sessionOver(editor);
    session.seedOpenNote('Scratch');
    typeTitle(session, 'Plan');

    editor.park('Scratch (conflict 2026-11-03)');
    expect(session.title).toBe('Plan');
    session.followEditorNote('Elsewhere', 'Elsewhere (conflict 2026-11-03)', true);
    expect(session.originalId).toBe('Scratch (conflict 2026-11-03)');
  });

  it('never saves for an editor that holds no note', async () => {
    const { session, deps } = sessionOver(editor);
    session.seedOpenNote('Scratch');

    await deps.openEditorNote(null, false);
    await session.flushSave();

    expect(deps.saveEditorNote).not.toHaveBeenCalled();
  });
});
