// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './__test__/noteSessionMocks';
import type { NoteSessionDeps } from './noteSession.svelte.ts';
import { typeTitle } from './__test__/typeTitle';
import { createFakeEditor, sessionOver, type FakeEditor } from './__test__/fakeEditor';

let editor: FakeEditor;

function openSession(overrides: Partial<NoteSessionDeps> = {}) {
  return sessionOver(editor, overrides);
}

it('seeds and reattaches the editor with the session identity while the route lags', () => {
  editor = createFakeEditor();
  const { session, deps } = openSession();
  session.seedOpenNote('created-id');
  expect(deps.openEditorNote).toHaveBeenLastCalledWith('created-id', false);
  editor.moved('renamed-id');
  session.reattachEditor();
  expect(deps.openEditorNote).toHaveBeenLastCalledWith('renamed-id', false);
});

function useTitleSaveFakes(): void {
  editor = createFakeEditor();
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
      const { session, deps } = openSession();
      editor.disk.set('A', 'original A');
      session.seedOpenNote('A');
      editor.keystroke('unsaved A');
      deps.saveEditorNote.mockRejectedValueOnce(new Error('disk full'));

      await expect(session.loadNote(destination)).rejects.toThrow('disk full');

      expect(editor.draft).toBe('unsaved A');
      expect(session.originalId).toBe('A');
      expect(session.savedContent).toBe('original A');
      // The editor was never handed anything but A.
      expect(deps.openEditorNote).toHaveBeenCalledExactlyOnceWith('A', false);
      await session.flushSave();
      expect(session.savedContent).toBe('unsaved A');
    },
  );

  // A locked vault (VaultUnavailableBanner) refuses every save for the rest of the
  // launch, so a failed save holding the user on the note would last until quit.
  it.each([
    ['a saved note', 'A'],
    ['a new note', 'new'],
  ])('leaves %s while the vault is locked, though its save failed', async (_, id) => {
    editor.disk.set('A', 'original A');
    editor.disk.set('B', 'disk B');
    const { session } = openSession({ isVaultLocked: () => true });
    if (id === 'A') session.seedOpenNote('A');
    else await session.loadNote('new');
    editor.keystroke('unsaved text');
    // Every write fails: the flush, and the save the editor's close makes first.
    editor.failSaves = true;

    await session.loadNote('B');

    expect(session.originalId).toBe('B');
    expect(editor.draft).toBe('disk B');
  });
});

describe("the title saves on its own debounce; the body is the host's", () => {
  beforeEach(useTitleSaveFakes);
  afterEach(restoreTitleSaveFakes);

  it('does NOT rename mid-typing: a title-only edit holds for ~10s, not 500ms', async () => {
    const { session, deps } = openSession();
    session.seedOpenNote('Untitled');

    typeTitle(session, 'Grocery list');
    expect(session.title).toBe('Grocery list');

    vi.advanceTimersByTime(500);
    await vi.runAllTicks();
    expect(deps.renameEditorNote).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);
    await vi.runAllTicks();
    expect(deps.renameEditorNote).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await vi.runAllTicks();
    expect(deps.renameEditorNote).toHaveBeenCalledExactlyOnceWith('Grocery list');
  });

  it('schedules no save of its own for a body edit: the host saves it', async () => {
    const { session, deps } = openSession();
    session.seedOpenNote('Untitled');

    editor.type('# hello body');
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deps.saveEditorNote).not.toHaveBeenCalled();
    expect(deps.renameEditorNote).not.toHaveBeenCalled();
    // What sync and the outside-change coordinator read still moves.
    expect(session.editorContent).toBe('# hello body');
    expect(session.editVersion).toBe(1);
  });

  it('reports a save pending while the editor holds an edit its host has not written', async () => {
    const { session } = openSession();
    session.seedOpenNote('Untitled');
    await vi.runAllTicks();

    editor.type('# hello body');
    // Sync defers, the outside-change coordinator settles first, quitting waits.
    expect(session.savePending).toBe(true);

    editor.hostSave();
    expect(session.savePending).toBe(false);
  });

  it('is clean after saving a title with trailing whitespace', async () => {
    const { session } = openSession();
    session.seedOpenNote('Untitled');

    typeTitle(session, 'Foo ');
    await session.flushSave();

    expect(session.dirty).toBe(false);
  });

  it('flushes editor content even when rAF never delivered onchange', async () => {
    const { session, deps } = openSession();
    await session.loadNote('new');
    editor.keystroke('# hidden-window keystroke');

    await session.flushSave();

    expect(deps.saveEditorNote).toHaveBeenCalledOnce();
    expect(session.savedContent).toBe('# hidden-window keystroke');
  });

  it('queues a title save typed during a local move until the session has retargeted', async () => {
    const { session, deps } = openSession();
    session.seedOpenNote('Projects/Roadmap');

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
      // The store moved the attachment; the host has not reported it yet.
      editor.relocate('Archive/Roadmap');
    });
    await moveStarted;

    typeTitle(session, 'Plan');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.renameEditorNote).not.toHaveBeenCalled();

    releaseMove();
    await moving;
    await vi.waitFor(() => expect(deps.renameEditorNote).toHaveBeenCalledOnce());
    // The host names the destination from where it holds the note: the move stays.
    expect(deps.renameEditorNote).toHaveBeenCalledWith('Plan');
    expect(session.originalId).toBe('Archive/Plan');
  });
});

describe('a focused title changes only by typing (list.md)', () => {
  beforeEach(() => {
    useTitleSaveFakes();
    editor.disk.set('Roadmap', 'body');
  });
  afterEach(() => {
    restoreTitleSaveFakes();
    document.body.replaceChildren();
  });

  function focusedTitleSession() {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    const { session, deps } = openSession({ getTitleTextarea: () => textarea });
    session.seedOpenNote('Untitled');
    const blur = () => {
      textarea.blur();
      session.handleTitleBlur();
    };
    return { session, deps, blur };
  }

  it('keeps the space a save trimmed off in the field, then shows the saved title on blur', async () => {
    const { session, deps, blur } = focusedTitleSession();

    typeTitle(session, 'jkl ');
    await session.flushSave();
    expect(session.fieldTitle).toBe('jkl ');
    expect(session.title).toBe('jkl');

    await session.flushSave();
    expect(deps.renameEditorNote).toHaveBeenCalledOnce();

    blur();
    expect(session.fieldTitle).toBe('jkl');
  });

  it('keeps holding through a window switch, which blurs the field but leaves it active', async () => {
    const { session, deps, blur } = focusedTitleSession();

    typeTitle(session, 'jkl ');
    await session.flushSave();
    session.handleTitleBlur();
    expect(session.fieldTitle).toBe('jkl ');

    blur();
    expect(session.fieldTitle).toBe('jkl');
  });

  it('lets typing after the save win over the saved title', async () => {
    const { session, deps, blur } = focusedTitleSession();

    typeTitle(session, 'jkl ');
    await session.flushSave();
    typeTitle(session, 'jkl mno');
    blur();

    expect(session.fieldTitle).toBe('jkl mno');
    expect(session.title).toBe('jkl mno');
  });

  it('holds a sync rename in the field until blur, without renaming it back', async () => {
    const { session, deps, blur } = focusedTitleSession();
    session.seedOpenNote('Roadmap');

    editor.moved('Plan');
    expect(session.fieldTitle).toBe('Roadmap');
    expect(session.title).toBe('Plan');

    await session.flushSave();
    expect(deps.renameEditorNote).not.toHaveBeenCalled();

    blur();
    expect(session.fieldTitle).toBe('Plan');
  });

  it('keeps a title typed before a sync rename and saves it under the new name', async () => {
    const { session, deps } = focusedTitleSession();
    session.seedOpenNote('Roadmap');
    typeTitle(session, 'Roadmap v2');

    editor.moved('Plan');
    expect(session.fieldTitle).toBe('Roadmap v2');

    await session.flushSave();
    expect(deps.renameEditorNote).toHaveBeenCalledExactlyOnceWith('Roadmap v2');
  });

  it('lets a sync rename replace a typed title that cannot save, even with a save armed', () => {
    const { session, deps } = openSession();
    session.seedOpenNote('Roadmap');
    typeTitle(session, 'Roadmap.');
    session.debouncedSave('body edited');

    editor.moved('Plan');

    expect(session.fieldTitle).toBe('Plan');
  });

  it('keeps a typed title whose save failed and retries it under the new name', async () => {
    const { session, deps } = openSession();
    session.seedOpenNote('Roadmap');
    typeTitle(session, 'Roadmap v2');
    deps.renameEditorNote.mockRejectedValueOnce(new Error('disk full'));
    await expect(session.flushSave()).rejects.toThrow('disk full');

    editor.moved('Plan');
    expect(session.fieldTitle).toBe('Roadmap v2');

    await session.flushSave();
    expect(deps.renameEditorNote).toHaveBeenLastCalledWith('Roadmap v2');
  });

  it('keeps the warning of a held blocked title until blur shows the new name', () => {
    const { session, deps, blur } = focusedTitleSession();
    session.seedOpenNote('Roadmap');
    typeTitle(session, 'Roadmap.');
    expect(session.titleWarning).not.toBe('');

    editor.moved('Plan');
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
    const { session, deps } = openSession({ getNotes: () => notes });
    session.seedOpenNote('Roadmap');
    typeTitle(session, 'Plan');
    await session.flushSave();
    expect(session.titleWarning).not.toBe('');
    expect(deps.renameEditorNote).not.toHaveBeenCalled();

    editor.moved('Work/Roadmap');
    expect(session.titleWarning).toBe('');

    await vi.runAllTimersAsync();
    expect(deps.renameEditorNote).toHaveBeenCalledExactlyOnceWith('Plan');
    expect(session.originalId).toBe('Work/Plan');
  });

  it('keeps a blocked typed title and its warning through a body adopt', () => {
    const { session, deps, blur } = focusedTitleSession();
    session.seedOpenNote('Roadmap');
    typeTitle(session, 'Roadmap.');

    session.applyExternalContent('peer body');
    blur();

    expect(session.fieldTitle).toBe('Roadmap.');
    expect(session.titleWarning).not.toBe('');
  });

  it('takes a body adopt through the editor in place, never a reload', () => {
    const { session, deps } = openSession();
    session.seedOpenNote('Roadmap');

    session.applyExternalContent('peer body');

    expect(deps.takeOutsideEditorChange).toHaveBeenCalledOnce();
    expect(deps.reloadEditorNote).not.toHaveBeenCalled();
  });

  it('shows a sync rename at once when the title is not focused', () => {
    const { session, deps } = openSession();
    session.seedOpenNote('Roadmap');

    editor.moved('Plan');

    expect(session.fieldTitle).toBe('Plan');
  });
});
