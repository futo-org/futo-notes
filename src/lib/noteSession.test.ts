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

describe('title debounce vs body debounce (character-loss race)', () => {
  // Regression: while typing a brand-new note's title, every keystroke armed
  // the same 500ms debouncedSave timer the body uses. A natural ~0.5s pause
  // mid-typing fired saveNote() → updateNote() (a file RENAME) → onNoteRenamed
  // → tab noteId swap, all async and mid-keystroke. Keystrokes that landed
  // during that round-trip got clobbered (the title binding / saved state was
  // reset to the post-rename value), so characters intermittently vanished.
  //
  // Desired behavior: a title-only edit must NOT trigger the rename until the
  // user has been idle ~10s, OR until focus moves into the editor body. Body
  // content edits keep their existing 500ms debounce.

  let editorContent = '';

  function makeDeps() {
    return {
      getEditorContent: () => editorContent,
      setEditorContent: vi.fn((text: string) => { editorContent = text; }),
      focusEditor: vi.fn(),
      focusTitle: vi.fn(),
      getNotes: () => [],
      patchGraphNode: vi.fn(),
      showToast: vi.fn(),
      notifySaved: vi.fn(),
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => 'new',
      setPrevNoteId: vi.fn(),
      onNoteRenamed: vi.fn(),
    } satisfies NoteSessionDeps;
  }

  // Drive handleTitleInput keystroke-by-keystroke against a fake textarea so
  // it mirrors a real user typing into the title field. In the running app the
  // `bind:value={session.title}` binding writes session.title before oninput
  // fires; mirror that here (handleTitleInput's no-issue branch relies on it).
  function typeTitle(
    session: ReturnType<typeof createNoteSession>,
    fullTitle: string,
  ): void {
    for (let i = 1; i <= fullTitle.length; i++) {
      const value = fullTitle.slice(0, i);
      // `title` is typed readonly on the session API (runtime has a setter for
      // the `bind:value` binding); mirror that write directly in the test.
      (session as { title: string }).title = value;
      const target = { value, selectionStart: value.length, setSelectionRange: vi.fn() };
      session.handleTitleInput({ target } as unknown as Event);
    }
  }

  beforeEach(async () => {
    editorContent = '';
    const { updateNote } = await import('$lib/notes.svelte');
    vi.mocked(updateNote).mockReset();
    vi.mocked(updateNote).mockImplementation(async (id: string) => ({ id, mtime: 0 }));
    vi.useFakeTimers();
    // The session's first save can re-arm via runQueuedSave microtasks; keep
    // requestAnimationFrame synchronous so handleTitleInput's caret restore
    // doesn't leak real timers into the fake-timer world.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does NOT rename mid-typing: a title-only edit holds for ~10s, not 500ms', async () => {
    const deps = makeDeps();
    const session = createNoteSession(deps);
    const { updateNote } = await import('$lib/notes.svelte');

    typeTitle(session, 'Grocery list');

    // The old 500ms body-debounce would already fire the rename here — that
    // is exactly the round-trip that clobbers in-flight keystrokes.
    vi.advanceTimersByTime(500);
    await vi.runAllTicks();
    expect(updateNote).not.toHaveBeenCalled();

    // Still nothing well before the 10s aggressive title debounce elapses.
    vi.advanceTimersByTime(8000);
    await vi.runAllTicks();
    expect(updateNote).not.toHaveBeenCalled();

    // Only after the user pauses ~10s does the rename land — once, with the
    // FULL title intact (no characters lost).
    vi.advanceTimersByTime(2000);
    await vi.runAllTicks();
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateNote).mock.calls[0][1]).toBe('Grocery list');
  });

  it('body content edits keep the existing short (500ms) debounce', async () => {
    const deps = makeDeps();
    const session = createNoteSession(deps);
    const { updateNote } = await import('$lib/notes.svelte');

    // Body change carries content (handleTitleInput passes none).
    session.debouncedSave('# hello body');

    vi.advanceTimersByTime(500);
    await vi.runAllTicks();
    expect(updateNote).toHaveBeenCalledTimes(1);
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

describe('opening a note is read-only (no autosave on line-ending normalization)', () => {
  // Regression: a years-old note stored with CRLF endings jumped to the top of
  // the list and spawned a `… (conflict <date>).md` copy the moment it was
  // clicked. loadNote seeded savedContent from the raw disk bytes (CRLF) while
  // CM6 (no lineSeparator facet) handed the content back LF-normalized, so the
  // rAF-coalesced onchange echo of the load looked like a user edit and
  // autosaved — bumping mtime (which re-sorts the note to the top) and pushing
  // a whole-file change that conflict-copied during sync. Opening must be a
  // pure read.
  let editorDoc = '';

  function makeDeps() {
    return {
      getEditorContent: () => editorDoc,
      // Mirror CM6: loading a doc with no lineSeparator facet collapses
      // CR/CRLF to LF.
      setEditorContent: vi.fn((text: string) => { editorDoc = text.replace(/\r\n?/g, '\n'); }),
      focusEditor: vi.fn(),
      focusTitle: vi.fn(),
      getNotes: () => [],
      patchGraphNode: vi.fn(),
      showToast: vi.fn(),
      notifySaved: vi.fn(),
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => 'old note',
      setPrevNoteId: vi.fn(),
      onNoteRenamed: vi.fn(),
    } satisfies NoteSessionDeps;
  }

  beforeEach(async () => {
    editorDoc = '';
    const { updateNote } = await import('$lib/notes.svelte');
    vi.mocked(updateNote).mockReset();
    vi.mocked(updateNote).mockImplementation(async (id: string) => ({ id, mtime: 0 }));
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not rewrite a CRLF note to disk just because it was opened', async () => {
    const deps = makeDeps();
    const { updateNote, readNote } = await import('$lib/notes.svelte');
    // mockResolvedValueOnce queues a one-time return ahead of the default
    // throwing impl, so loadNote's single readNote call gets these bytes.
    vi.mocked(readNote).mockResolvedValueOnce('line one\r\nline two\r\n');

    const session = createNoteSession(deps);
    await session.loadNote('old note');

    // The session baseline must match what the editor holds (LF), not the raw
    // CRLF disk bytes — otherwise the load echo registers as a change.
    expect(session.content).toBe('line one\nline two\n');

    // The editor's rAF-coalesced onchange now delivers the normalized doc.
    session.debouncedSave(editorDoc);
    vi.advanceTimersByTime(600);
    await vi.runAllTicks();

    expect(updateNote).not.toHaveBeenCalled();
  });
});
