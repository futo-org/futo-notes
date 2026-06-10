// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loadNote's focus routing branches on isMobile, which $lib/platform exports
// as a const — expose it through a hoisted getter so each test can flip it.
const platformState = vi.hoisted(() => ({ isMobile: false }));

vi.mock('$lib/platform', () => ({
  hasFileSystem: true,
  get isMobile() { return platformState.isMobile; },
  showSoftKeyboard: vi.fn(async () => {}),
}));

vi.mock('$lib/notes.svelte', () => ({
  updateNote: vi.fn(),
  readNote: vi.fn(async () => { throw new Error('note does not exist'); }),
  createNote: vi.fn(async (id: string) => ({ id, mtime: 0 })),
  getNoteById: vi.fn(() => undefined),
}));

import { createNoteSession, editorHasUnseenChanges, isEditorChangeEcho, shouldWriteNoteToDisk } from './noteSession.svelte.ts';
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
    // Regression: programmatic setEditorContent('') during loadNote('new')
    // used to fire a phantom debouncedSave, which wrote an empty note
    // to disk just because originalId was null.
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
  // Regression: the editor's onchange is rAF-coalesced, and rAF stalls while
  // the window is hidden/occluded (macOS WKWebView). Typed content then never
  // arms the save timer, so flushSave used to no-op and the keystrokes were
  // silently dropped on close/quit/note-switch (caught by the cross-platform
  // "tombstone does not block new note" scenario running with hidden windows).
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
  // Regression: applyExternalContent raises suppressSaveOnChange around its
  // setEditorContent call, but the editor's onchange is rAF-coalesced — the
  // delivery lands one frame later, after the flag is already lowered. That
  // echo bumped editVersion, so handleSyncComplete's editedDuringSync gate
  // silently skipped every SUBSEQUENT remote adopt of the open note: the
  // first live-pulled edit appeared, the second never did until the note was
  // reopened (observed 2026-06-04, iPhone → mac "Yes." / "No." repro).
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
    // Doc went old → old+x → old. The second delivery matches savedContent
    // but NOT the session's last-seen content, so it must flow through
    // (otherwise session.content would be left stale at old+x).
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

describe('loadNote focus routing', () => {
  function makeDeps(noteId: string = 'new') {
    return {
      getEditorContent: () => '',
      setEditorContent: vi.fn(),
      focusEditor: vi.fn(),
      focusTitle: vi.fn(),
      getNotes: () => [],
      patchGraphNode: vi.fn(),
      showToast: vi.fn(),
      notifySaved: vi.fn(),
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => noteId,
      setPrevNoteId: vi.fn(),
      onNoteRenamed: vi.fn(),
    } satisfies NoteSessionDeps;
  }

  beforeEach(() => {
    // loadNote defers focus to the next frame; run it synchronously so the
    // assertions don't need to wait out a real rAF tick.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    platformState.isMobile = false;
  });

  it("focuses the title for '+ New' / quick capture on mobile", async () => {
    // Spec gap (list.md): on Tauri mobile a fresh note should land focus on
    // the title — handleTitleFocus select-alls "Untitled" so typing replaces
    // it — instead of dropping the user into the body.
    platformState.isMobile = true;
    const deps = makeDeps();
    await createNoteSession(deps).loadNote('new');
    expect(deps.focusTitle).toHaveBeenCalledOnce();
    expect(deps.focusEditor).not.toHaveBeenCalled();
  });

  it("keeps body focus for '+ New' on desktop", async () => {
    const deps = makeDeps();
    await createNoteSession(deps).loadNote('new');
    expect(deps.focusEditor).toHaveBeenCalledOnce();
    expect(deps.focusTitle).not.toHaveBeenCalled();
  });

  it('keeps body focus when a wikilink creates a missing note, even on mobile', async () => {
    // Following [[missing note]] already names the note — the user's next
    // keystroke belongs in the body on every platform.
    platformState.isMobile = true;
    const deps = makeDeps('missing note');
    await createNoteSession(deps).loadNote('missing note');
    expect(deps.focusEditor).toHaveBeenCalledOnce();
    expect(deps.focusTitle).not.toHaveBeenCalled();
  });
});
