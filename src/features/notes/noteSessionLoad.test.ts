// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './__test__/noteSessionMocks';
import { typeTitle } from './__test__/typeTitle';
import { createFakeEditor, sessionOver, type FakeEditor } from './__test__/fakeEditor';
import { createNote, deleteNote, noteExists } from './notes.svelte';

let editor: FakeEditor;
let routeNoteId: string | null = null;

function openSession(overrides: Parameters<typeof sessionOver>[1] = {}) {
  return sessionOver(editor, { getNoteId: () => routeNoteId, ...overrides });
}

/** A promise whose settlement the test controls. */
function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  editor = createFakeEditor(
    new Map([
      ['A', 'A body'],
      ['B', 'B body'],
    ]),
  );
  routeNoteId = 'A';
  vi.mocked(createNote).mockClear();
  vi.mocked(deleteNote).mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadNote focus routing', () => {
  it("creates '+ New' in the pending folder, moves the tab to it and focuses the body", async () => {
    vi.mocked(createNote).mockResolvedValueOnce({ id: 'Work/Untitled-1', mtime: 0 });
    routeNoteId = 'new';
    const { session, deps } = openSession({ getPendingFolder: () => 'Work' });
    await session.loadNote('new');
    expect(createNote).toHaveBeenCalledExactlyOnceWith('Work/Untitled', '');
    expect(deps.onNoteRenamed).toHaveBeenCalledExactlyOnceWith(null, 'Work/Untitled-1');
    expect(deps.openEditorNote).toHaveBeenCalledWith('Work/Untitled-1', false);
    expect(session.originalId).toBe('Work/Untitled-1');
    expect(session.title).toBe('Untitled-1');
    expect(deps.focusEditor).toHaveBeenCalledOnce();
  });

  it('creates a missing wikilink target before the editor attaches it, without forcing focus', async () => {
    // The editor attaches only a note on disk; only the '+ New' path forces body focus.
    vi.mocked(noteExists).mockResolvedValueOnce(false);
    routeNoteId = 'missing note';
    const { session, deps } = openSession();
    await session.loadNote('missing note');
    expect(createNote).toHaveBeenCalledExactlyOnceWith('missing note', '');
    expect(deps.openEditorNote).toHaveBeenCalledWith('missing note', false);
    expect(session.originalId).toBe('missing note');
    expect(deps.focusEditor).not.toHaveBeenCalled();
  });

  it('keeps the user on the outgoing note when the new note cannot be created', async () => {
    vi.mocked(createNote).mockRejectedValueOnce(new Error('Permission denied'));
    const { session, deps } = openSession();
    session.seedOpenNote('A');

    await expect(session.loadNote('new')).rejects.toThrow('Permission denied');
    expect(session.originalId).toBe('A');
    expect(deps.openEditorNote).toHaveBeenCalledExactlyOnceWith('A', false);
  });

  it('refuses a note whose existence cannot be read, never creating it', async () => {
    vi.mocked(noteExists).mockRejectedValueOnce(new Error('temporary read failure'));
    const { session, deps } = openSession();
    session.seedOpenNote('A');

    await expect(session.loadNote('broken')).rejects.toThrow('temporary read failure');

    expect(createNote).not.toHaveBeenCalled();
    expect(session.originalId).toBe('A');
    expect(deps.openEditorNote).toHaveBeenCalledExactlyOnceWith('A', false);
  });

  it('does not let an open that a cancel overtook repopulate the session', async () => {
    const { session, deps } = openSession();
    const opening = gate();
    deps.openEditorNote.mockImplementationOnce(() => opening.promise);

    const load = session.loadNote('B');
    await vi.waitFor(() => expect(deps.openEditorNote).toHaveBeenCalledWith('B', false));
    session.cancelAndClear();
    opening.resolve();
    await load;

    expect(session.title).toBe('');
    expect(session.editorContent).toBeUndefined();
    expect(session.originalId).toBeNull();
    expect(session.loading).toBe(false);
    expect(deps.navigate).toHaveBeenLastCalledWith('/');
  });

  it('releases the editor when the open note goes away', async () => {
    const { session, deps } = openSession();
    await session.loadNote('A');
    deps.openEditorNote.mockClear();

    session.cancelAndClear();

    expect(deps.openEditorNote).toHaveBeenCalledWith(null, false);
  });
});

describe('the editor opens a note before the session describes it', () => {
  it('keeps the outgoing note until the editor holds the incoming one', async () => {
    const { session, deps } = openSession();
    session.seedOpenNote('A');
    const opening = gate();
    const open = deps.openEditorNote.getMockImplementation()!;
    deps.openEditorNote.mockImplementationOnce(async (id, discard) => {
      await opening.promise;
      await open(id, discard);
    });

    routeNoteId = 'B';
    const load = session.loadNote('B');
    await vi.waitFor(() => expect(deps.openEditorNote).toHaveBeenLastCalledWith('B', false));
    expect(session.originalId).toBe('A');
    expect(session.title).toBe('A');
    expect(session.savedContent).toBe('A body');

    opening.resolve();
    await load;
    expect(session.originalId).toBe('B');
    expect(session.title).toBe('B');
    expect(session.editorContent).toBe('B body');
    expect(session.savedContent).toBe('B body');
  });

  it('leaves the session on the outgoing note when the editor cannot open the incoming one', async () => {
    const { session, deps } = openSession();
    session.seedOpenNote('A');
    // DesktopEditor keeps the note it had when an open fails.
    deps.openEditorNote.mockRejectedValueOnce(new Error('editor host closed'));

    routeNoteId = 'B';
    await expect(session.loadNote('B')).rejects.toThrow('editor host closed');

    expect(session.originalId).toBe('A');
    expect(session.title).toBe('A');
    expect(session.editorContent).toBe('A body');
    expect(session.savedContent).toBe('A body');
    expect(session.loading).toBe(false);
  });

  it("takes the editor's saved source as its baseline, even when the note loaded before the editor was bound", async () => {
    // A restored tab: the session loads its note while no editor is mounted yet.
    const { session, deps } = openSession();
    deps.openEditorNote.mockImplementationOnce(async () => {});
    routeNoteId = 'B';
    await session.loadNote('B');
    expect(session.originalId).toBe('B');

    // The editor mounts and the shell hands it the note: the baseline is what it opened.
    session.reattachEditor();
    await vi.waitFor(() => expect(editor.noteId).toBe('B'));
    expect(session.savedContent).toBe('B body');
    expect(session.dirty).toBe(false);
  });
});

describe('leaving a note the session created', () => {
  async function openNewNote() {
    vi.mocked(createNote).mockResolvedValueOnce({ id: 'Untitled', mtime: 0 });
    routeNoteId = 'new';
    const opened = openSession();
    await opened.session.loadNote('new');
    routeNoteId = 'Untitled';
    return opened;
  }

  it.each([
    ['for another note', 'B'],
    ['for home', null],
  ])('deletes it untouched when the user leaves %s', async (_, destination) => {
    const { session, deps } = await openNewNote();

    routeNoteId = destination;
    await session.loadNote(destination);

    await vi.waitFor(() => expect(deps.onNoteDeleted).toHaveBeenCalledWith('Untitled'));
    expect(deleteNote).toHaveBeenCalledExactlyOnceWith('Untitled');
  });

  it('deletes it when its body was typed and erased again, as on the phones', async () => {
    const { session } = await openNewNote();
    editor.type('x');
    editor.type('');

    routeNoteId = 'B';
    await session.loadNote('B');

    await vi.waitFor(() => expect(deleteNote).toHaveBeenCalledExactlyOnceWith('Untitled'));
  });

  it('keeps it typed in when a second switch starts while the first is in flight', async () => {
    const { session, deps } = await openNewNote();
    editor.type('typed');
    const open = deps.openEditorNote.getMockImplementation()!;
    const switching = gate();
    deps.openEditorNote.mockImplementationOnce(async (id, discard) => {
      editor.hide();
      await switching.promise;
      await open(id, discard);
    });

    routeNoteId = 'B';
    const first = session.loadNote('B');
    await vi.waitFor(() => expect(deps.openEditorNote).toHaveBeenCalledWith('B', false));
    routeNoteId = 'A';
    const second = session.loadNote('A');
    // The second switch decides what it leaves while the first is still in flight.
    await vi.waitFor(() => expect(deps.openEditorNote).toHaveBeenCalledWith('A', false));
    switching.resolve();
    await Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteNote).not.toHaveBeenCalled();
  });

  it('keeps it when the user goes back to it while the switch away is in flight', async () => {
    const { session, deps } = await openNewNote();
    deps.openEditorNote.mockClear();
    const open = deps.openEditorNote.getMockImplementation()!;
    const switching = gate();
    // The editor runs its switches in order (DesktopEditor `openNote`).
    let away!: Promise<void>;
    deps.openEditorNote.mockImplementationOnce((id, discard) => {
      away = (async () => {
        editor.hide();
        await switching.promise;
        await open(id, discard);
      })();
      return away;
    });
    deps.openEditorNote.mockImplementationOnce(async (id, discard) => {
      await away;
      await open(id, discard);
    });

    routeNoteId = 'B';
    const toB = session.loadNote('B');
    await vi.waitFor(() => expect(deps.openEditorNote).toHaveBeenCalledWith('B', false));
    routeNoteId = 'Untitled';
    const back = session.loadNote('Untitled');
    await vi.waitFor(() => expect(deps.openEditorNote).toHaveBeenCalledWith('Untitled', false));
    switching.resolve();
    await Promise.allSettled([toB, back]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteNote).not.toHaveBeenCalled();
    expect(session.originalId).toBe('Untitled');
    // Still the untouched note New note made: leaving it now deletes it.
    routeNoteId = 'B';
    await session.loadNote('B');
    await vi.waitFor(() => expect(deleteNote).toHaveBeenCalledExactlyOnceWith('Untitled'));
  });

  it('keeps it when the editor could not open the next note', async () => {
    const { session, deps } = await openNewNote();
    deps.openEditorNote.mockRejectedValueOnce(new Error('editor host closed'));

    routeNoteId = 'B';
    await expect(session.loadNote('B')).rejects.toThrow('editor host closed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteNote).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a rename',
      (session: Awaited<ReturnType<typeof openNewNote>>['session']) => typeTitle(session, 'Plan'),
    ],
    ['a keystroke no change report carried yet', () => editor.keystroke('x')],
  ])('keeps it after %s', async (_, touch) => {
    const { session } = await openNewNote();

    touch(session);
    routeNoteId = 'B';
    await session.loadNote('B');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteNote).not.toHaveBeenCalled();
  });
});
