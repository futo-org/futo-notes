// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('$features/sync/autoSync', () => ({ notifySaved: vi.fn() }));
vi.mock('./notes.svelte', () => ({
  updateNote: vi.fn(),
  readNote: vi.fn(async () => ''),
  getNoteById: vi.fn(() => undefined),
  _applyLocalMutation: vi.fn(),
  recordSaveIdentityChange: vi.fn(),
}));

import { createNoteSession, type NoteSessionDeps } from './noteSession.svelte.ts';
import { readNote, updateNote } from './notes.svelte';

// A local rename relinks the open note's file behind the editor (the store
// suppresses the watcher for its own writes). The session must take the
// rewritten file as its baseline before any save, or that save — conditioned
// on the pre-rewrite bytes — parks a conflict copy nobody made. The e2e is
// tests/cross-platform-sync.mjs "a rename that relinks the open note…"; this
// pins the one branch it cannot reach deterministically: typing that lands
// while the rename commits.
describe('a relink of the open note', () => {
  let editorDoc = '';
  const deps = (): NoteSessionDeps => ({
    getEditorContent: () => editorDoc,
    setEditorContent: vi.fn((text: string) => {
      editorDoc = text;
    }),
    openEditorNote: vi.fn((text: string) => {
      editorDoc = text;
    }),
    focusEditor: vi.fn(),
    isEditorFocused: () => true,
    isComposing: () => false,
    getNotes: () => [],
    getNoteBody: () => undefined,
    getTitleTextarea: () => undefined,
    getNoteId: () => 'Hub',
    setPrevNoteId: vi.fn(),
    onNoteRenamed: vi.fn(),
    reconcileOpenNote: vi.fn(async () => false),
    navigate: vi.fn(),
  });

  async function openHub(sessionDeps: NoteSessionDeps) {
    vi.mocked(readNote).mockResolvedValueOnce('see [[Target]] here');
    const session = createNoteSession(sessionDeps);
    await session.loadNote('Hub');
    return session;
  }

  beforeEach(() => {
    editorDoc = '';
    vi.mocked(readNote).mockReset();
    vi.mocked(updateNote).mockReset();
    vi.mocked(updateNote).mockImplementation(async (id: string) => ({
      id,
      mtime: 0,
      disposition: 'wrote' as const,
      unappliedMutation: null,
    }));
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is adopted into a clean editor, even a focused one', async () => {
    const sessionDeps = deps();
    const session = await openHub(sessionDeps);
    vi.mocked(readNote).mockResolvedValueOnce('see [[Target moved]] here');

    session.noteRelinked(['Hub']);
    await session.runWithSaveLock(async () => {});

    expect(sessionDeps.setEditorContent).toHaveBeenCalledWith('see [[Target moved]] here');
    expect(session.savedContent).toBe('see [[Target moved]] here');
    expect(session.dirty).toBe(false);
  });

  it('keeps typing that landed while the rename committed, saved over the rewritten file', async () => {
    const sessionDeps = deps();
    const session = await openHub(sessionDeps);
    editorDoc = 'see [[Target]] here, typed';
    session.debouncedSave(editorDoc);
    vi.mocked(readNote).mockResolvedValueOnce('see [[Target moved]] here');

    session.noteRelinked(['Hub']);
    await session.flushSave();

    expect(sessionDeps.setEditorContent).not.toHaveBeenCalled();
    expect(updateNote).toHaveBeenCalledOnce();
    expect(updateNote).toHaveBeenCalledWith('Hub', 'see [[Target]] here, typed', {
      originalId: 'Hub',
      base: 'see [[Target moved]] here',
    });
  });

  it('leaves the editor alone when another note was relinked', async () => {
    const sessionDeps = deps();
    const session = await openHub(sessionDeps);

    session.noteRelinked(['Elsewhere']);
    await session.runWithSaveLock(async () => {});

    expect(readNote).toHaveBeenCalledOnce(); // the open itself
    expect(sessionDeps.setEditorContent).not.toHaveBeenCalled();
  });
});
