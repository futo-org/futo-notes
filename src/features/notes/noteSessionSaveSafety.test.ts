// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './__test__/noteSessionMocks';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';
import { createExternalChangeCoordinator } from '$features/sync/createExternalChangeCoordinator';
import { createNoteSession } from './noteSession.svelte.ts';
import type { NoteSessionDeps } from './noteSession.svelte.ts';
import { typeTitle } from './__test__/typeTitle';

describe('external unlink during an in-flight save', () => {
  let editorContent = '';

  beforeEach(async () => {
    const { updateNote } = await import('./notes.svelte');
    vi.mocked(updateNote).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not clear the save's renamed identity", async () => {
    let routeNoteId: string | null = 'active';
    let resolveSave!: (result: { id: string; mtime: number; disposition: 'wrote' }) => void;
    const saveResult = new Promise<{ id: string; mtime: number; disposition: 'wrote' }>(
      (resolve) => {
        resolveSave = resolve;
      },
    );
    const deps = {
      getEditorContent: () => editorContent,
      setEditorContent: vi.fn((text: string) => {
        editorContent = text;
      }),
      openEditorNote: vi.fn((_noteId: string | null, text: string) => {
        editorContent = text;
      }),
      focusEditor: vi.fn(),
      isEditorFocused: () => false,
      isComposing: () => false,
      getNotes: () => [],
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => routeNoteId,
      setPrevNoteId: vi.fn(),
      navigate: vi.fn((path: string) => {
        if (path === '/') routeNoteId = null;
      }),
      onNoteRenamed: vi.fn(),
      reconcileOpenNote: vi.fn(async () => false),
    } satisfies NoteSessionDeps;
    const session = createNoteSession(deps);
    const { updateNote } = await import('./notes.svelte');
    const { notifySaved } = await import('$features/sync/autoSync');
    vi.mocked(updateNote).mockImplementationOnce(() => saveResult);
    vi.mocked(notifySaved).mockClear();
    session.seedOpenNote('active', 'base');

    editorContent = 'draft';
    session.debouncedSave(editorContent);
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(updateNote).toHaveBeenCalledOnce();

    const externalChanges = createExternalChangeCoordinator({
      followRename: vi.fn(),
      session,
      notifySaved: vi.fn(),
      showToast: vi.fn(),
      writeSuppressor: createWriteSuppressor(),
    });
    const handlingUnlink = externalChanges.handleFileChange({
      type: 'unlink',
      filename: 'active.md',
    });
    await Promise.resolve();
    expect(session.originalId).toBe('active');

    resolveSave({ id: 'Renamed', mtime: 0, disposition: 'wrote' });
    await handlingUnlink;

    expect(session.originalId).toBe('Renamed');
    expect(session.title).toBe('active');
    expect(session.content).toBe('draft');
    expect(deps.onNoteRenamed).toHaveBeenCalledExactlyOnceWith('active', 'Renamed');
    expect(notifySaved).toHaveBeenCalledOnce();
    expect(updateNote).toHaveBeenCalledOnce();
    expect(session.savePending).toBe(false);
    externalChanges.stop();
  });
});

describe('stale first-save completion after navigation', () => {
  let editorContent = '';

  beforeEach(async () => {
    const { readNote, updateNote } = await import('./notes.svelte');
    vi.mocked(readNote).mockReset();
    vi.mocked(updateNote).mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not rebind a new-note save that resolves after another note was opened', async () => {
    let routeNoteId: string | null = 'new';
    let resolveSave!: (result: { id: string; mtime: number; disposition: 'wrote' }) => void;
    let resolveOtherRead!: (content: string) => void;
    const saveResult = new Promise<{ id: string; mtime: number; disposition: 'wrote' }>(
      (resolve) => {
        resolveSave = resolve;
      },
    );
    const otherRead = new Promise<string>((resolve) => {
      resolveOtherRead = resolve;
    });
    const deps = {
      getEditorContent: () => editorContent,
      setEditorContent: vi.fn((text: string) => {
        editorContent = text;
      }),
      openEditorNote: vi.fn((_noteId: string | null, text: string) => {
        editorContent = text;
      }),
      focusEditor: vi.fn(),
      isEditorFocused: () => false,
      isComposing: () => false,
      getNotes: () => [],
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => routeNoteId,
      setPrevNoteId: vi.fn(),
      navigate: vi.fn(),
      onNoteRenamed: vi.fn(),
      reconcileOpenNote: vi.fn(async () => false),
    } satisfies NoteSessionDeps;
    const { readNote, updateNote } = await import('./notes.svelte');
    vi.mocked(updateNote).mockImplementationOnce(() => saveResult);
    vi.mocked(readNote).mockImplementationOnce(() => otherRead);
    const session = createNoteSession(deps);
    await session.loadNote('new');

    editorContent = 'first draft';
    session.debouncedSave(editorContent);
    await vi.advanceTimersByTimeAsync(500);
    expect(updateNote).toHaveBeenCalledOnce();

    routeNoteId = 'other';
    const openingOther = session.loadNote('other');
    resolveSave({ id: 'Untitled', mtime: 0, disposition: 'wrote' });
    await vi.waitFor(() => expect(readNote).toHaveBeenCalledWith('other'));

    // The outgoing session is the new note's until the other note is read,
    // and the stale first save did not rebind it (nor save it again).
    expect(session.originalId).toBeNull();
    expect(session.savedContent).toBe('');
    expect(deps.onNoteRenamed).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledOnce();

    resolveOtherRead('other content');
    await openingOther;
    expect(session.originalId).toBe('other');
    expect(deps.onNoteRenamed).not.toHaveBeenCalled();
  });
});

describe('save straddling a note switch (F1)', () => {
  let editorContent = '';
  let routeNoteId: string | null = 'A';

  function makeDeps() {
    return {
      getEditorContent: () => editorContent,
      setEditorContent: vi.fn((text: string) => {
        editorContent = text;
      }),
      openEditorNote: vi.fn((_noteId: string | null, text: string) => {
        editorContent = text;
      }),
      forgetEditorNote: vi.fn(),
      focusEditor: vi.fn(),
      isEditorFocused: () => false,
      isComposing: () => false,
      getNotes: () => [],
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => routeNoteId,
      setPrevNoteId: vi.fn(),
      navigate: vi.fn(),
      onNoteRenamed: vi.fn(),
      reconcileOpenNote: vi.fn(async () => false),
    } satisfies NoteSessionDeps;
  }

  beforeEach(async () => {
    editorContent = '';
    routeNoteId = 'A';
    const { readNote, updateNote } = await import('./notes.svelte');
    vi.mocked(readNote).mockReset();
    vi.mocked(updateNote).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a late edit to the outgoing note instead of writing it to the note being opened', async () => {
    const deps = makeDeps();
    const session = createNoteSession(deps);
    const { readNote, updateNote } = await import('./notes.svelte');

    session.seedOpenNote('A', 'A body v1');

    // A first edit debounces normally and its save is left in flight.
    let resolveFirstSave!: (result: { id: string; mtime: number; disposition: 'wrote' }) => void;
    const firstSave = new Promise<{ id: string; mtime: number; disposition: 'wrote' }>(
      (resolve) => {
        resolveFirstSave = resolve;
      },
    );
    vi.mocked(updateNote).mockImplementationOnce(() => firstSave);
    vi.mocked(updateNote).mockImplementation(async (id: string) => ({
      id,
      mtime: 0,
      disposition: 'wrote',
    }));

    editorContent = 'A body v2';
    session.debouncedSave(editorContent);
    await vi.advanceTimersByTimeAsync(500);
    expect(updateNote).toHaveBeenCalledOnce();

    // The user now switches to note B while that first save is still
    // in-flight; readNote('B') is held open so `loading` stays observable.
    let resolveReadB!: (content: string) => void;
    const readB = new Promise<string>((resolve) => {
      resolveReadB = resolve;
    });
    vi.mocked(readNote).mockImplementationOnce(() => readB);
    // The read of B overlaps A's save, and the keystroke below lands during
    // it, so B is read again behind the flush (createNoteLoader readIncoming).
    vi.mocked(readNote).mockResolvedValue('B body');
    routeNoteId = 'B';
    const opening = session.loadNote('B');

    // A keystroke lands while flushSave() is still awaiting the first save
    // and `loading` has not flipped yet — this arms a fresh debounce timer
    // that a naive flush() has already snapshotted past.
    editorContent = 'A body v3 (typed during in-flight save)';
    session.debouncedSave(editorContent);

    resolveFirstSave({ id: 'A', mtime: 0, disposition: 'wrote' });
    await vi.waitFor(() => expect(readNote).toHaveBeenCalledWith('B'));

    // Give any surviving debounce timer a chance to fire while B is still
    // loading: originalId has already flipped to 'B', but title/savedContent
    // still belong to A until readNote('B') resolves.
    await vi.advanceTimersByTimeAsync(500);

    expect(updateNote).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ originalId: 'B' }),
    );
    // The late edit must reach A's own file, not be silently dropped.
    expect(updateNote).toHaveBeenCalledWith('A', 'A body v3 (typed during in-flight save)', {
      originalId: 'A',
      base: 'A body v2',
    });

    resolveReadB('B body');
    await opening;
    expect(session.originalId).toBe('B');
    expect(session.content).toBe('B body');
  });
});

/*

/*
 * 2026-09-03 DATA LOSS. Three notes in a live vault were overwritten with 0
 * bytes: two while a hot-module reload replaced the editor component under an
 * open note, one after a note whose markdown made the parser throw was left
 * displayed blank. Both leave the SAME state — the editor holds an empty
 * document for a note it never loaded — and the session read that '' as "the
 * user deleted everything" and wrote it over the file (the Rust store's
 * flush_draft truncates a note whose base still matches disk, by design).
 *
 * The root-cause fix is in MilkdownEditor (it must never report a document it
 * failed to load, or never loaded); this is the save pipeline's own half, so
 * no future editor that goes blank can empty a note through it.
 */
describe('an editor that lost the note never empties it on disk', () => {
  let editorDoc: string | undefined = '';
  let activeNoteId: string | null = null;

  /**
   * `editorTakesContent: false` is the editor whose parse threw: the host hands
   * it the note and the document stays empty.
   */
  function makeDeps(editorTakesContent = true) {
    return {
      getEditorContent: () => editorDoc,
      setEditorContent: vi.fn((text: string) => {
        if (editorTakesContent) editorDoc = text;
      }),
      openEditorNote: vi.fn((_noteId: string | null, text: string) => {
        if (editorTakesContent) editorDoc = text;
      }),
      focusEditor: vi.fn(),
      isEditorFocused: () => false,
      isComposing: () => false,
      getNotes: () => [],
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => activeNoteId,
      setPrevNoteId: vi.fn(),
      onNoteRenamed: vi.fn(),
      reconcileOpenNote: vi.fn(async () => false),
      navigate: vi.fn(),
    } satisfies NoteSessionDeps;
  }

  beforeEach(async () => {
    editorDoc = '';
    activeNoteId = null;
    const { updateNote, readNote } = await import('./notes.svelte');
    vi.mocked(updateNote).mockReset();
    vi.mocked(updateNote).mockImplementation(async (id: string) => ({
      id,
      mtime: 0,
      disposition: 'wrote' as const,
    }));
    vi.mocked(readNote).mockReset();
    vi.mocked(readNote).mockResolvedValue('');
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Opens `id`, whose disk copy holds `body`. */
  async function openNoteWithBody(deps: NoteSessionDeps, id: string, body: string) {
    const { readNote, updateNote } = await import('./notes.svelte');
    vi.mocked(readNote).mockResolvedValueOnce(body);
    activeNoteId = id;
    const session = createNoteSession(deps);
    await session.loadNote(id);
    vi.mocked(updateNote).mockClear();
    return session;
  }

  it('does not adopt an empty editor document as the saved baseline of a note with content', async () => {
    // The parse threw: the host handed the note over and the editor kept nothing.
    const deps = makeDeps(false);
    const session = await openNoteWithBody(deps, 'How to Do Great Work', '# Great Work\n\nbody\n');

    expect(session.savedContent).toBe('# Great Work\n\nbody\n');
    expect(session.content).toBe('# Great Work\n\nbody\n');
  });

  it('flushing a session whose editor went blank leaves the note untouched', async () => {
    const deps = makeDeps();
    const session = await openNoteWithBody(deps, 'How to Do Great Work', 'eight thousand bytes\n');
    const { updateNote } = await import('./notes.svelte');

    // The component is replaced (hot reload) / the deferred parse throws: the
    // editor now answers for a document that is not this note.
    editorDoc = '';
    await session.flushSave();

    expect(updateNote).not.toHaveBeenCalled();
    expect(session.dirty).toBe(false);
  });

  it('switching away from a blank editor does not write an empty body', async () => {
    const deps = makeDeps();
    const session = await openNoteWithBody(deps, 'CI flake log', 'several paragraphs\n');
    const { updateNote } = await import('./notes.svelte');

    editorDoc = '';
    activeNoteId = 'other note';
    await session.loadNote('other note');

    expect(updateNote).not.toHaveBeenCalled();
  });

  it('still renames a note whose editor went blank, carrying the body it knows', async () => {
    const deps = makeDeps();
    const session = await openNoteWithBody(deps, 'The feed is dying', 'two hundred bytes\n');
    const { updateNote } = await import('./notes.svelte');

    editorDoc = '';
    typeTitle(session, 'The feed is reborn');
    await session.flushSave();

    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateNote).mock.calls[0][1]).toBe('two hundred bytes\n');
  });

  it('still empties a note the user really did clear, reported through onchange', async () => {
    const deps = makeDeps();
    const session = await openNoteWithBody(deps, 'Scratch', 'delete me\n');
    const { updateNote } = await import('./notes.svelte');

    // A real select-all-delete reaches the session as a change notification.
    editorDoc = '';
    session.debouncedSave('');
    await session.flushSave();

    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateNote).mock.calls[0][1]).toBe('');
  });

  it('never writes for an editor that reports nothing at all', async () => {
    const deps = makeDeps();
    const session = await openNoteWithBody(deps, 'Unmounted', 'still here\n');
    const { updateNote } = await import('./notes.svelte');

    editorDoc = undefined;
    await session.flushSave();

    expect(updateNote).not.toHaveBeenCalled();
  });
});
