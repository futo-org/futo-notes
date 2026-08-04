// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({
  hasFileSystem: true,
}));
vi.mock('$features/sync/autoSyncV2', () => ({ notifySavedV2: vi.fn() }));

vi.mock('./notes.svelte', () => ({
  updateNote: vi.fn(),
  // Missing reads as "" on every platform (Tauri notes_read, web.ts, nodeFS) —
  // read_note never throws for a missing file. The default mirrors that; tests
  // that need specific bytes queue them with mockResolvedValueOnce.
  readNote: vi.fn(async () => ''),
  createNote: vi.fn(async (id: string) => ({ id, mtime: 0 })),
  getNoteById: vi.fn(() => undefined),
  handleExternalFileChange: vi.fn(async () => {}),
  refreshNotesFromStorage: vi.fn(async () => {}),
}));

import { createWriteSuppressor } from '$lib/platform/writeSuppression';
import { createExternalChangeCoordinator } from '$features/sync/createExternalChangeCoordinator';
import {
  createNoteSession,
  editorHasUnseenChanges,
  isEditorChangeEcho,
  shouldWriteNoteToDisk,
} from './noteSession.svelte.ts';
import type { NoteSessionDeps } from './noteSession.svelte.ts';

describe('shouldWriteNoteToDisk', () => {
  it('persists a new note when the title was changed', () => {
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Untitled',
        newTitle: 'Title only',
        content: '',
        newContent: '',
      }),
    ).toBe(true);
  });

  it('skips writes for a brand-new note that was never touched', () => {
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Untitled (1)',
        newTitle: 'Untitled (1)',
        content: '',
        newContent: '',
      }),
    ).toBe(false);
  });

  it('skips writes for existing notes when neither title nor content changed', () => {
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Existing',
        newTitle: 'Existing',
        content: '',
        newContent: '',
      }),
    ).toBe(false);
  });
});

describe('editorHasUnseenChanges', () => {
  it('reports typed content the save pipeline never saw', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: '# Fresh note',
        savedContent: '',
        title: 'Untitled',
        savedTitle: 'Untitled',
      }),
    ).toBe(true);
  });

  it('reports an unsaved title-only change', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: 'body',
        savedContent: 'body',
        title: 'Renamed',
        savedTitle: 'Original',
      }),
    ).toBe(true);
  });

  it('is clean when editor and title match the last save', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: 'body',
        savedContent: 'body',
        title: 'Same',
        savedTitle: 'Same',
      }),
    ).toBe(false);
  });

  it('is clean when there is no editor (content undefined)', () => {
    expect(
      editorHasUnseenChanges({
        editorContent: undefined,
        savedContent: 'anything',
        title: 'a',
        savedTitle: 'b',
      }),
    ).toBe(false);
  });
});

describe('isEditorChangeEcho', () => {
  it('treats the rAF-deferred delivery of adopted content as an echo', () => {
    expect(
      isEditorChangeEcho({
        nextContent: 'remote content',
        content: 'remote content',
        savedContent: 'remote content',
      }),
    ).toBe(true);
  });

  it('treats a real edit as an edit', () => {
    expect(
      isEditorChangeEcho({
        nextContent: 'remote content plus a keystroke',
        content: 'remote content',
        savedContent: 'remote content',
      }),
    ).toBe(false);
  });

  it('still counts a type-then-revert delivery so session content converges', () => {
    expect(
      isEditorChangeEcho({
        nextContent: 'old',
        content: 'old+x',
        savedContent: 'old',
      }),
    ).toBe(false);
  });

  it('never classifies a title-only debounce (no content payload) as an echo', () => {
    expect(
      isEditorChangeEcho({
        nextContent: undefined,
        content: 'body',
        savedContent: 'body',
      }),
    ).toBe(false);
  });
});

let titleEditorContent = '';

function makeTitleDeps() {
  return {
    getEditorContent: () => titleEditorContent,
    setEditorContent: vi.fn((text: string) => {
      titleEditorContent = text;
    }),
    focusEditor: vi.fn(),
    isEditorFocused: () => false,
    isComposing: () => false,
    getNotes: () => [],
    getNoteBody: () => undefined,
    getTitleTextarea: () => undefined,
    getNoteId: () => 'new',
    setPrevNoteId: vi.fn(),
    onNoteRenamed: vi.fn(),
    reconcileOpenNote: vi.fn(async () => false),
    navigate: vi.fn(),
  } satisfies NoteSessionDeps;
}

function typeTitle(session: ReturnType<typeof createNoteSession>, fullTitle: string): void {
  for (let i = 1; i <= fullTitle.length; i++) {
    const value = fullTitle.slice(0, i);
    const target = { value, selectionStart: value.length, setSelectionRange: vi.fn() };
    session.handleTitleInput({ target } as unknown as Event);
  }
}

async function useTitleSaveFakes(): Promise<void> {
  titleEditorContent = '';
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
}

function restoreTitleSaveFakes(): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

describe('committing the title without waiting out the debounce', () => {
  beforeEach(useTitleSaveFakes);
  afterEach(restoreTitleSaveFakes);

  it('renames on flush with no timer advance at all', async () => {
    const session = createNoteSession(makeTitleDeps());
    const { updateNote } = await import('./notes.svelte');

    typeTitle(session, 'Grocery list');
    await session.flushSave();

    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateNote).mock.calls[0][1]).toBe('Grocery list');
  });

  it('renames when the title field loses focus', async () => {
    const session = createNoteSession(makeTitleDeps());
    const { updateNote } = await import('./notes.svelte');

    typeTitle(session, 'Grocery list');
    session.handleTitleBlur();
    // Microtasks only: reaching the 10 s backstop would rename regardless.
    await vi.advanceTimersByTimeAsync(0);

    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateNote).mock.calls[0][1]).toBe('Grocery list');
  });
});

describe('title debounce vs body debounce (character-loss race)', () => {
  beforeEach(useTitleSaveFakes);
  afterEach(restoreTitleSaveFakes);

  it('does NOT rename mid-typing: a title-only edit holds for ~10s, not 500ms', async () => {
    const deps = makeTitleDeps();
    const session = createNoteSession(deps);
    const { updateNote } = await import('./notes.svelte');

    typeTitle(session, 'Grocery list');
    expect(session.title).toBe('Grocery list');

    vi.advanceTimersByTime(500);
    await vi.runAllTicks();
    expect(updateNote).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);
    await vi.runAllTicks();
    expect(updateNote).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await vi.runAllTicks();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateNote).mock.calls[0][1]).toBe('Grocery list');
  });

  it('body content edits keep the existing short (500ms) debounce', async () => {
    const deps = makeTitleDeps();
    const session = createNoteSession(deps);
    const { updateNote } = await import('./notes.svelte');

    session.debouncedSave('# hello body');

    vi.advanceTimersByTime(500);
    await vi.runAllTicks();
    expect(updateNote).toHaveBeenCalledTimes(1);
  });

  it('is clean after saving a title with trailing whitespace', async () => {
    const session = createNoteSession(makeTitleDeps());

    typeTitle(session, 'Foo ');
    await session.flushSave();

    expect(session.dirty).toBe(false);
  });

  it('flushes editor content even when rAF never delivered onchange', async () => {
    const session = createNoteSession(makeTitleDeps());
    await session.loadNote('new');
    titleEditorContent = '# hidden-window keystroke';

    await session.flushSave();

    const { updateNote } = await import('./notes.svelte');
    expect(updateNote).toHaveBeenCalledWith('Untitled', 'Untitled', '# hidden-window keystroke', {
      originalId: undefined,
      base: '',
    });
  });

  it('awaits only an in-flight save without starting a scheduled save', async () => {
    const session = createNoteSession(makeTitleDeps());
    const { updateNote } = await import('./notes.svelte');

    session.debouncedSave('# scheduled');
    await session.awaitSaveIdle();

    expect(updateNote).not.toHaveBeenCalled();
    expect(session.savePending).toBe(true);
  });

  it('queues saves typed during a local move until the session has retargeted', async () => {
    const session = createNoteSession(makeTitleDeps());
    const { updateNote } = await import('./notes.svelte');
    session.seedOpenNote('Projects/Roadmap', 'base');
    titleEditorContent = 'base';

    let releaseMove!: () => void;
    let markMoveStarted!: () => void;
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moveGate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const moving = session.runWithSaveLock(async () => {
      markMoveStarted();
      await moveGate;
      session.applyRemoteRename('Archive/Roadmap', 'Roadmap');
    });
    await moveStarted;

    titleEditorContent = 'draft typed during move';
    session.debouncedSave(titleEditorContent);
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(updateNote).not.toHaveBeenCalled();

    releaseMove();
    await moving;
    await vi.waitFor(() => expect(updateNote).toHaveBeenCalledOnce());
    expect(updateNote).toHaveBeenCalledWith(
      'Archive/Roadmap',
      'Roadmap',
      'draft typed during move',
      { originalId: 'Archive/Roadmap', base: 'base' },
    );
  });
});

describe('stale save completion after an external close', () => {
  let editorContent = '';

  beforeEach(async () => {
    const { updateNote } = await import('./notes.svelte');
    vi.mocked(updateNote).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the session cleared when an external unlink races an in-flight save completion', async () => {
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
    const { notifySavedV2 } = await import('$features/sync/autoSyncV2');
    vi.mocked(updateNote).mockImplementationOnce(() => saveResult);
    vi.mocked(notifySavedV2).mockClear();
    session.seedOpenNote('active', 'base');

    editorContent = 'draft';
    session.debouncedSave(editorContent);
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(updateNote).toHaveBeenCalledOnce();

    const externalChanges = createExternalChangeCoordinator({
      session,
      notifySaved: vi.fn(),
      showToast: vi.fn(),
      writeSuppressor: createWriteSuppressor(),
    });
    await externalChanges.handleFileChange({ type: 'unlink', filename: 'active.md' });

    resolveSave({ id: 'Renamed', mtime: 0, disposition: 'wrote' });
    await session.flushSave();

    expect(session.originalId).toBeNull();
    expect(session.title).toBe('');
    expect(session.content).toBe('');
    expect(deps.onNoteRenamed).not.toHaveBeenCalled();
    expect(notifySavedV2).toHaveBeenCalledOnce();
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

    expect(session.originalId).toBe('other');
    expect(session.savedContent).toBe('');
    expect(deps.onNoteRenamed).not.toHaveBeenCalled();

    resolveOtherRead('other content');
    await openingOther;
  });
});

describe('loadNote focus routing', () => {
  function makeDeps(noteId: string = 'new') {
    return {
      getEditorContent: () => '',
      setEditorContent: vi.fn(),
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
    expect(deps.setEditorContent).toHaveBeenCalledWith('');
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
    expect(deps.setEditorContent).not.toHaveBeenCalledWith('late content');
    expect(deps.navigate).toHaveBeenLastCalledWith('/');
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
