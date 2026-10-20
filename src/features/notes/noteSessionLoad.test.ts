// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './__test__/noteSessionMocks';
import { createNoteSession } from './noteSession.svelte.ts';
import type { NoteSessionDeps } from './noteSession.svelte.ts';
import { typeTitle } from './__test__/typeTitle';

describe('loadNote focus routing', () => {
  function makeDeps(noteId: string = 'new') {
    return {
      getEditorContent: () => '',
      setEditorContent: vi.fn(),
      openEditorNote: vi.fn(),
      focusEditor: vi.fn(),
      isEditorFocused: () => false,
      isComposing: () => false,
      getNotes: () => [],
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => noteId,
      setPrevNoteId: vi.fn(),
      onNoteRenamed: vi.fn(),
      reconcileOpenNote: vi.fn(async () => false),
      navigate: vi.fn(),
    } satisfies NoteSessionDeps;
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("focuses the body when opening '+ New'", async () => {
    const deps = makeDeps();
    await createNoteSession(deps).loadNote('new');
    expect(deps.focusEditor).toHaveBeenCalledOnce();
  });

  it('opens a broken-wikilink target as an empty deferred note (no eager create, no forced focus)', async () => {
    // Tapping [[missing note]] opens an empty editor bound to the target title;
    // the file is created on the FIRST edit/save, not eagerly (2026-07-11
    // decision — docs/spec/editor.md). read_note returns "" for the missing
    // file, so loadNote takes the normal read path: no createNote, and opening
    // does not grab editor focus (same as opening any existing note — only the
    // '+ New' path forces body focus).
    const { readNote, createNote } = await import('./notes.svelte');
    vi.mocked(readNote).mockResolvedValueOnce('');
    const deps = makeDeps('missing note');
    const session = createNoteSession(deps);
    await session.loadNote('missing note');
    expect(createNote).not.toHaveBeenCalled();
    expect(deps.openEditorNote).toHaveBeenCalledWith('missing note', '');
    expect(session.originalId).toBe('missing note');
    expect(deps.focusEditor).not.toHaveBeenCalled();
  });

  it('clears the complete session after a backend read failure', async () => {
    const { readNote } = await import('./notes.svelte');
    vi.mocked(readNote)
      .mockResolvedValueOnce('stale body')
      .mockRejectedValueOnce(new Error('temporary read failure'));
    const deps = makeDeps('broken');
    const session = createNoteSession(deps);
    await session.loadNote('previous');

    await session.loadNote('broken');

    expect(session.title).toBe('');
    expect(session.content).toBe('');
    expect(session.originalId).toBeNull();
    expect(session.loading).toBe(false);
    expect(deps.navigate).toHaveBeenLastCalledWith('/');
  });

  it('does not let a deferred read repopulate a cancelled session', async () => {
    const { readNote } = await import('./notes.svelte');
    let resolveRead!: (content: string) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const pendingRead = new Promise<string>((resolve) => {
      resolveRead = resolve;
    });
    vi.mocked(readNote).mockImplementationOnce(() => {
      markReadStarted();
      return pendingRead;
    });
    const deps = makeDeps('slow');
    const session = createNoteSession(deps);

    const load = session.loadNote('slow');
    await readStarted;
    session.cancelAndClear();
    resolveRead('late content');
    await load;

    expect(session.title).toBe('');
    expect(session.content).toBe('');
    expect(session.originalId).toBeNull();
    expect(session.loading).toBe(false);
    expect(deps.openEditorNote).not.toHaveBeenCalledWith(expect.anything(), 'late content');
    expect(deps.navigate).toHaveBeenLastCalledWith('/');
  });

  it('releases the editor when the open note goes away', async () => {
    const deps = makeDeps('doomed');
    const session = createNoteSession(deps);
    await session.loadNote('doomed');
    deps.openEditorNote.mockClear();

    session.cancelAndClear();

    expect(deps.openEditorNote).toHaveBeenCalledWith(null, '');
  });
});

describe('opening a note is read-only (no autosave on line-ending normalization)', () => {
  let editorDoc = '';

  function makeDeps() {
    return {
      getEditorContent: () => editorDoc,
      setEditorContent: vi.fn((text: string) => {
        editorDoc = text.replace(/\r\n?/g, '\n');
      }),
      openEditorNote: vi.fn((_noteId: string | null, text: string) => {
        editorDoc = text.replace(/\r\n?/g, '\n');
      }),
      focusEditor: vi.fn(),
      isEditorFocused: () => false,
      isComposing: () => false,
      getNotes: () => [],
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => 'old note',
      setPrevNoteId: vi.fn(),
      onNoteRenamed: vi.fn(),
      reconcileOpenNote: vi.fn(async () => false),
      navigate: vi.fn(),
    } satisfies NoteSessionDeps;
  }

  beforeEach(async () => {
    editorDoc = '';
    const { updateNote } = await import('./notes.svelte');
    vi.mocked(updateNote).mockReset();
    vi.mocked(updateNote).mockImplementation(async (id: string) => ({
      id,
      mtime: 0,
      disposition: 'wrote',
    }));
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not rewrite a CRLF note to disk just because it was opened', async () => {
    const deps = makeDeps();
    const { updateNote, readNote } = await import('./notes.svelte');
    // mockResolvedValueOnce queues a one-time return ahead of the default
    // empty-string impl, so loadNote's single readNote call gets these bytes.
    vi.mocked(readNote).mockResolvedValueOnce('line one\r\nline two\r\n');

    const session = createNoteSession(deps);
    await session.loadNote('old note');

    expect(session.content).toBe('line one\nline two\n');

    session.debouncedSave(editorDoc);
    vi.advanceTimersByTime(600);
    await vi.runAllTicks();

    expect(updateNote).not.toHaveBeenCalled();
  });
});

describe('reading the incoming note while the outgoing note saves', () => {
  let editorContent = '';
  let routeNoteId: string | null = 'A';
  /* What the store has written, so a read after a save sees the save. */
  let disk = new Map<string, string>();
  let releaseHeldSave: (() => void) | null = null;

  function makeDeps() {
    return {
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
  }

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Holds the next save open until `releaseHeldSave()`. */
  async function holdNextSave(): Promise<void> {
    const { updateNote } = await import('./notes.svelte');
    vi.mocked(updateNote).mockImplementationOnce(async (id: string, body: string) => {
      await new Promise<void>((resolve) => {
        releaseHeldSave = resolve;
      });
      disk.set(id, body);
      return { id, mtime: 0, disposition: 'wrote' };
    });
  }

  /** Note A open, with an edit no save has seen. */
  function openDirtyA() {
    const session = createNoteSession(makeDeps());
    session.seedOpenNote('A', 'A body');
    editorContent = 'A body edited';
    session.debouncedSave(editorContent);
    return session;
  }

  beforeEach(async () => {
    editorContent = '';
    routeNoteId = 'A';
    disk = new Map([
      ['A', 'A body'],
      ['B', 'B body'],
    ]);
    releaseHeldSave = null;
    const { readNote, updateNote } = await import('./notes.svelte');
    vi.mocked(readNote).mockReset();
    vi.mocked(readNote).mockImplementation(async (id: string) => disk.get(id) ?? '');
    vi.mocked(updateNote).mockReset();
    vi.mocked(updateNote).mockImplementation(async (id: string, body: string) => {
      disk.set(id, body);
      return { id, mtime: 0, disposition: 'wrote' };
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads B while A's save is still writing, and opens B once that save lands", async () => {
    const { readNote, updateNote } = await import('./notes.svelte');
    const session = openDirtyA();
    await holdNextSave();

    routeNoteId = 'B';
    const opening = session.loadNote('B');
    await settle();
    expect(updateNote).toHaveBeenCalledWith('A', 'A body edited', expect.anything());
    expect(readNote).toHaveBeenCalledWith('B');
    expect(session.originalId).toBe('A');

    releaseHeldSave?.();
    await opening;
    expect(disk.get('A')).toBe('A body edited');
    expect(session.originalId).toBe('B');
    expect(session.content).toBe('B body');
    expect(readNote).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the note being saved', 'A'],
    ['a case variant of its id, which is the same file on macOS and Windows', 'a'],
  ])('waits for the save before reading %s', async (_name, incoming) => {
    const { readNote } = await import('./notes.svelte');
    const session = openDirtyA();
    await holdNextSave();

    routeNoteId = incoming;
    const opening = session.loadNote(incoming);
    await settle();
    expect(readNote).not.toHaveBeenCalled();

    releaseHeldSave?.();
    await opening;
    expect(readNote).toHaveBeenCalledOnce();
  });

  it('waits for a save that renames, since a rename rewrites links in other notes', async () => {
    const { readNote } = await import('./notes.svelte');
    const session = createNoteSession(makeDeps());
    session.seedOpenNote('A', 'A body');
    editorContent = 'A body';
    typeTitle(session, 'A renamed');
    await holdNextSave();

    routeNoteId = 'B';
    const opening = session.loadNote('B');
    await settle();
    expect(readNote).not.toHaveBeenCalled();

    releaseHeldSave?.();
    await opening;
    expect(readNote).toHaveBeenCalledWith('B');
  });

  it('switching straight back to the note being saved reads what the save wrote', async () => {
    const { readNote } = await import('./notes.svelte');
    const session = openDirtyA();
    await holdNextSave();

    routeNoteId = 'B';
    const leaving = session.loadNote('B');
    await settle();
    expect(readNote).toHaveBeenCalledWith('B');

    // Back to A before B landed: A's save is still writing, so A waits for it.
    routeNoteId = 'A';
    const returning = session.loadNote('A');
    await settle();
    expect(readNote).not.toHaveBeenCalledWith('A');

    releaseHeldSave?.();
    await Promise.all([leaving, returning]);
    expect(readNote).toHaveBeenLastCalledWith('A');
    expect(session.originalId).toBe('A');
    expect(session.content).toBe('A body edited');
  });
});
