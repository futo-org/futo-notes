// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './__test__/noteSessionMocks';
import { createNoteSession } from './noteSession.svelte.ts';
import type { NoteSessionDeps } from './noteSession.svelte.ts';
import { typeTitle } from './__test__/typeTitle';

let titleEditorContent = '';

function makeTitleDeps() {
  return {
    getEditorContent: () => titleEditorContent,
    setEditorContent: vi.fn((text: string) => {
      titleEditorContent = text;
    }),
    openEditorNote: vi.fn((_noteId: string | null, text: string) => {
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

it('seeds and reattaches the editor with the session identity while the route lags', () => {
  const deps = makeTitleDeps();
  const session = createNoteSession(deps);
  session.seedOpenNote('created-id', 'body');
  expect(deps.openEditorNote).toHaveBeenLastCalledWith('created-id', 'body');
  session.applyRemoteRename('renamed-id', 'renamed-id');
  session.reattachEditor();
  expect(deps.openEditorNote).toHaveBeenLastCalledWith('renamed-id', 'body');
});

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

describe('leaving a note whose save fails', () => {
  beforeEach(useTitleSaveFakes);
  afterEach(restoreTitleSaveFakes);

  it.each(['B', 'new', null])(
    'keeps the outgoing draft when save fails before opening %s',
    async (destination) => {
      const deps = makeTitleDeps();
      const session = createNoteSession(deps);
      const { updateNote, readNote } = await import('./notes.svelte');
      session.seedOpenNote('A', 'original A');
      titleEditorContent = 'unsaved A';
      vi.mocked(updateNote).mockRejectedValueOnce(new Error('disk full'));
      vi.mocked(readNote).mockClear();

      await expect(session.loadNote(destination)).rejects.toThrow('disk full');

      expect(titleEditorContent).toBe('unsaved A');
      expect(session.originalId).toBe('A');
      expect(session.savedContent).toBe('original A');
      // B may have been READ alongside the save (a different file), but the
      // editor was never handed anything but A.
      expect(deps.openEditorNote).toHaveBeenLastCalledWith('A', 'original A');
      if (destination !== 'B') expect(readNote).not.toHaveBeenCalled();
      await session.flushSave();
      expect(session.savedContent).toBe('unsaved A');
    },
  );

  // A locked vault (VaultUnavailableBanner) refuses every save for the rest of the
  // launch, so a failed save holding the user on the note would last until quit.
  function lockedSession() {
    let activeNoteId = 'A';
    const session = createNoteSession({
      ...makeTitleDeps(),
      getNoteId: () => activeNoteId,
      isVaultLocked: () => true,
    });
    const open = (id: string) => {
      activeNoteId = id;
      return session.loadNote(id);
    };
    return { session, open };
  }

  it.each([
    ['a saved note', 'A'],
    ['a never-saved note', 'new'],
  ])('leaves %s while the vault is locked, discarding its unsaved text', async (_, id) => {
    const { session, open } = lockedSession();
    const { updateNote, createNote, readNote } = await import('./notes.svelte');
    if (id === 'A') session.seedOpenNote('A', 'original A');
    else await open('new');
    titleEditorContent = 'unsaved text';
    const refused = new Error('Permission denied (os error 13)');
    vi.mocked(updateNote).mockRejectedValue(refused);
    vi.mocked(createNote).mockRejectedValue(refused);
    vi.mocked(readNote).mockResolvedValueOnce('disk B').mockResolvedValueOnce('original A');

    await open('B');
    expect(titleEditorContent).toBe('disk B');
    if (id === 'A') {
      await open('A');
      expect(titleEditorContent).toBe('original A');
    }
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
    expect(updateNote).toHaveBeenCalledExactlyOnceWith('Grocery list', '', {
      originalId: undefined,
      base: '',
    });
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
    expect(updateNote).toHaveBeenCalledWith('Untitled', '# hidden-window keystroke', {
      originalId: undefined,
      base: '',
    });
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
    expect(updateNote).toHaveBeenCalledWith('Archive/Roadmap', 'draft typed during move', {
      originalId: 'Archive/Roadmap',
      base: 'base',
    });
  });
});

describe('a focused title changes only by typing (list.md)', () => {
  beforeEach(useTitleSaveFakes);
  afterEach(() => {
    restoreTitleSaveFakes();
    document.body.replaceChildren();
  });

  function focusedTitleSession() {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    const session = createNoteSession({ ...makeTitleDeps(), getTitleTextarea: () => textarea });
    const blur = () => {
      textarea.blur();
      session.handleTitleBlur();
    };
    return { session, blur };
  }

  it('keeps the space a save trimmed off in the field, then shows the saved title on blur', async () => {
    const { session, blur } = focusedTitleSession();
    const { updateNote } = await import('./notes.svelte');

    typeTitle(session, 'jkl ');
    await session.flushSave();
    expect(session.fieldTitle).toBe('jkl ');
    expect(session.title).toBe('jkl');

    await session.flushSave();
    expect(updateNote).toHaveBeenCalledOnce();

    blur();
    expect(session.fieldTitle).toBe('jkl');
  });

  it('keeps holding through a window switch, which blurs the field but leaves it active', async () => {
    const { session, blur } = focusedTitleSession();

    typeTitle(session, 'jkl ');
    await session.flushSave();
    session.handleTitleBlur();
    expect(session.fieldTitle).toBe('jkl ');

    blur();
    expect(session.fieldTitle).toBe('jkl');
  });

  it('lets typing after the save win over the saved title', async () => {
    const { session, blur } = focusedTitleSession();

    typeTitle(session, 'jkl ');
    await session.flushSave();
    typeTitle(session, 'jkl mno');
    blur();

    expect(session.fieldTitle).toBe('jkl mno');
    expect(session.title).toBe('jkl mno');
  });

  it('holds a sync rename in the field until blur, without renaming it back', async () => {
    const { session, blur } = focusedTitleSession();
    const { updateNote } = await import('./notes.svelte');
    session.seedOpenNote('Roadmap', 'body');
    titleEditorContent = 'body';

    session.applyRemoteRename('Plan', 'Plan');
    expect(session.fieldTitle).toBe('Roadmap');
    expect(session.title).toBe('Plan');

    await session.flushSave();
    expect(updateNote).not.toHaveBeenCalled();

    blur();
    expect(session.fieldTitle).toBe('Plan');
  });

  it('keeps a title typed before a sync rename and saves it under the new name', async () => {
    const { session } = focusedTitleSession();
    const { updateNote } = await import('./notes.svelte');
    session.seedOpenNote('Roadmap', 'body');
    titleEditorContent = 'body';
    typeTitle(session, 'Roadmap v2');

    session.applyRemoteRename('Plan', 'Plan');
    expect(session.fieldTitle).toBe('Roadmap v2');

    await session.flushSave();
    expect(updateNote).toHaveBeenCalledExactlyOnceWith('Roadmap v2', 'body', {
      originalId: 'Plan',
      base: 'body',
    });
  });

  it('lets a sync rename replace a typed title that cannot save, even with a save armed', () => {
    const session = createNoteSession(makeTitleDeps());
    session.seedOpenNote('Roadmap', 'body');
    titleEditorContent = 'body';
    typeTitle(session, 'Roadmap.');
    session.debouncedSave('body edited');

    session.applyRemoteRename('Plan', 'Plan');

    expect(session.fieldTitle).toBe('Plan');
  });

  it('keeps a typed title whose save failed and retries it under the new name', async () => {
    const session = createNoteSession(makeTitleDeps());
    const { updateNote } = await import('./notes.svelte');
    session.seedOpenNote('Roadmap', 'body');
    titleEditorContent = 'body';
    typeTitle(session, 'Roadmap v2');
    vi.mocked(updateNote).mockRejectedValueOnce(new Error('disk full'));
    await expect(session.flushSave()).rejects.toThrow('disk full');

    session.applyRemoteRename('Plan', 'Plan');
    expect(session.fieldTitle).toBe('Roadmap v2');

    await session.flushSave();
    expect(updateNote).toHaveBeenLastCalledWith('Roadmap v2', 'body', {
      originalId: 'Plan',
      base: 'body',
    });
  });

  it('keeps the warning of a held blocked title until blur shows the new name', () => {
    const { session, blur } = focusedTitleSession();
    session.seedOpenNote('Roadmap', 'body');
    typeTitle(session, 'Roadmap.');
    expect(session.titleWarning).not.toBe('');

    session.applyRemoteRename('Plan', 'Plan');
    expect(session.fieldTitle).toBe('Roadmap.');
    expect(session.titleWarning).not.toBe('');

    blur();
    expect(session.fieldTitle).toBe('Plan');
    expect(session.titleWarning).toBe('');
  });

  it('saves a duplicate typed title once a move makes it unique, dropping the warning', async () => {
    const notes = [{ id: 'Plan' }, { id: 'Roadmap' }] as unknown as ReturnType<
      NoteSessionDeps['getNotes']
    >;
    const session = createNoteSession({ ...makeTitleDeps(), getNotes: () => notes });
    const { updateNote } = await import('./notes.svelte');
    session.seedOpenNote('Roadmap', 'body');
    titleEditorContent = 'body';
    typeTitle(session, 'Plan');
    await session.flushSave();
    expect(session.titleWarning).not.toBe('');
    expect(updateNote).not.toHaveBeenCalled();

    session.applyRemoteRename('Work/Roadmap', 'Roadmap');
    expect(session.titleWarning).toBe('');

    await vi.runAllTimersAsync();
    expect(updateNote).toHaveBeenCalledExactlyOnceWith('Work/Plan', 'body', {
      originalId: 'Work/Roadmap',
      base: 'body',
    });
  });

  it('keeps a blocked typed title and its warning through a body adopt', () => {
    const { session, blur } = focusedTitleSession();
    session.seedOpenNote('Roadmap', 'body');
    typeTitle(session, 'Roadmap.');

    session.applyExternalContent('peer body');
    blur();

    expect(session.fieldTitle).toBe('Roadmap.');
    expect(session.titleWarning).not.toBe('');
  });

  it('shows a sync rename at once when the title is not focused', () => {
    const session = createNoteSession(makeTitleDeps());
    session.seedOpenNote('Roadmap', 'body');

    session.applyRemoteRename('Plan', 'Plan');

    expect(session.fieldTitle).toBe('Plan');
  });
});
