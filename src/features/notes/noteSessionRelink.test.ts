// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('$features/sync/autoSync', () => ({ notifySaved: vi.fn() }));
vi.mock('./notes.svelte', () => ({
  readNote: vi.fn(async () => ''),
  noteExists: vi.fn(async () => true),
  getNoteById: vi.fn(() => undefined),
  recordSaveIdentityChange: vi.fn(),
}));

import { createFakeEditor, sessionOver, type FakeEditor } from './__test__/fakeEditor';
import { readNote } from './notes.svelte';

// A local rename relinks the open note's file behind the editor (the store
// suppresses the watcher for its own writes). The session must take the
// rewritten file as its baseline before any save, or that save — conditioned
// on the pre-rewrite bytes — parks a conflict copy nobody made. The e2e is
// tests/cross-platform-sync.mjs "a rename that relinks the open note…"; this
// pins the one branch it cannot reach deterministically: typing that lands
// while the rename commits.
describe('a relink of the open note', () => {
  let editor: FakeEditor;
  const deps = () => ({ isEditorFocused: () => true, getNoteId: () => 'Hub' });

  async function openHub(overrides = deps()) {
    const opened = sessionOver(editor, overrides);
    await opened.session.loadNote('Hub');
    return opened;
  }

  /** The workflow's backlink rewrite, on disk, which the session reads back. */
  function rewriteHub(text: string): void {
    editor.disk.set('Hub', text);
    vi.mocked(readNote).mockResolvedValueOnce(text);
  }

  beforeEach(() => {
    editor = createFakeEditor(new Map([['Hub', 'see [[Target]] here']]));
    vi.mocked(readNote).mockReset();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is adopted into a clean editor, even a focused one', async () => {
    const { session, deps: sessionDeps } = await openHub();
    rewriteHub('see [[Target moved]] here');

    session.noteRelinked(['Hub']);
    await session.runWithSaveLock(async () => {});

    expect(sessionDeps.reloadEditorNote).toHaveBeenCalledOnce();
    expect(editor.draft).toBe('see [[Target moved]] here');
    expect(session.savedContent).toBe('see [[Target moved]] here');
    expect(session.dirty).toBe(false);
  });

  it('keeps typing that landed while the rename committed, saved over the rewritten file', async () => {
    const { session, deps: sessionDeps } = await openHub();
    editor.type('see [[Target]] here, typed');
    rewriteHub('see [[Target moved]] here');

    session.noteRelinked(['Hub']);
    await session.flushSave();

    expect(sessionDeps.reloadEditorNote).not.toHaveBeenCalled();
    expect(editor.disk.get('Hub')).toBe('see [[Target]] here, typed');
    expect(session.savedContent).toBe('see [[Target]] here, typed');
  });

  it('leaves the editor alone when another note was relinked', async () => {
    const { session, deps: sessionDeps } = await openHub();

    session.noteRelinked(['Elsewhere']);
    await session.runWithSaveLock(async () => {});

    expect(readNote).not.toHaveBeenCalled();
    expect(sessionDeps.reloadEditorNote).not.toHaveBeenCalled();
  });
});
