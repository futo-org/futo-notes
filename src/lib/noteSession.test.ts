// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('$lib/autoSyncV2', () => ({ notifySavedV2: vi.fn() }));
vi.mock('$lib/notes.svelte', () => ({
  updateNote: vi.fn(async (id: string) => ({ id, mtime: 0 })),
  readNote: vi.fn(async () => ''),
  getNoteById: vi.fn(() => undefined),
}));

import { readNote, updateNote } from '$lib/notes.svelte';
import {
  createNoteSession,
  editorHasUnseenChanges,
  isEditorChangeEcho,
  shouldWriteNoteToDisk,
  type NoteSessionDeps,
} from './noteSession.svelte';

describe('draft decisions', () => {
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
        content: 'body',
        newContent: 'body',
      }),
    ).toBe(false);
  });

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
        savedContent: 'body',
        title: 'Renamed',
        savedTitle: 'Original',
      }),
    ).toBe(false);
  });

  it('treats the rAF-deferred delivery of adopted content as an echo', () => {
    expect(
      isEditorChangeEcho({
        nextContent: 'remote',
        content: 'remote',
        savedContent: 'remote',
      }),
    ).toBe(true);
  });

  it('treats a real edit as an edit', () => {
    expect(
      isEditorChangeEcho({
        nextContent: 'remote+x',
        content: 'remote',
        savedContent: 'remote',
      }),
    ).toBe(false);
  });

  it('still counts a type-then-revert delivery so session content converges', () => {
    expect(isEditorChangeEcho({ nextContent: 'old', content: 'old+x', savedContent: 'old' })).toBe(
      false,
    );
  });

  it('never classifies a title-only debounce (no content payload) as an echo', () => {
    expect(
      isEditorChangeEcho({ nextContent: undefined, content: 'body', savedContent: 'body' }),
    ).toBe(false);
  });
});

describe('note session lifecycle', () => {
  let editorContent = '';
  let routeId: string | null = 'new';

  function makeDeps(overrides: Partial<NoteSessionDeps> = {}): NoteSessionDeps {
    return {
      getEditorContent: () => editorContent,
      setEditorContent: (text) => {
        editorContent = text.replace(/\r\n?/g, '\n');
      },
      focusEditor: vi.fn(),
      isEditorFocused: () => false,
      isComposing: () => false,
      getNotes: () => [],
      getNoteBody: () => undefined,
      getTitleTextarea: () => undefined,
      getNoteId: () => routeId,
      getPendingFolder: () => null,
      clearPendingFolder: vi.fn(),
      onNoteRenamed: vi.fn(),
      ...overrides,
    };
  }

  function typeTitle(session: ReturnType<typeof createNoteSession>, value: string): void {
    session.title = value;
    session.handleTitleInput({
      target: { value, selectionStart: value.length, setSelectionRange: vi.fn() },
    } as unknown as Event);
  }

  beforeEach(() => {
    editorContent = '';
    routeId = 'new';
    vi.mocked(updateNote).mockClear();
    vi.mocked(readNote).mockReset();
    vi.mocked(readNote).mockResolvedValue('');
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

  it('does NOT rename mid-typing: a title-only edit holds for ~10s, not 500ms', async () => {
    const session = createNoteSession(makeDeps());
    typeTitle(session, 'Grocery list');

    await vi.advanceTimersByTimeAsync(9_999);
    expect(updateNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updateNote).toHaveBeenCalledOnce();
    expect(vi.mocked(updateNote).mock.calls[0][1]).toBe('Grocery list');
  });

  it('body content edits keep the existing short (500ms) debounce', async () => {
    const session = createNoteSession(makeDeps());
    session.debouncedSave('# hello body');
    await vi.advanceTimersByTimeAsync(499);
    expect(updateNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updateNote).toHaveBeenCalledOnce();
  });

  it('flushes editor content even when rAF never delivered onchange', async () => {
    const session = createNoteSession(makeDeps());
    await session.loadNote('new');
    editorContent = '# hidden-window keystroke';

    await session.flushSave();

    expect(updateNote).toHaveBeenCalledWith(
      'Untitled',
      'Untitled',
      '# hidden-window keystroke',
      undefined,
    );
  });

  it("focuses the body when opening '+ New'", async () => {
    const deps = makeDeps();
    await createNoteSession(deps).loadNote('new');
    expect(deps.focusEditor).toHaveBeenCalledOnce();
  });

  it('opens a broken-wikilink target as an empty deferred note', async () => {
    routeId = 'missing note';
    const deps = makeDeps();
    const session = createNoteSession(deps);
    await session.loadNote('missing note');

    expect(session.originalId).toBe('missing note');
    expect(session.content).toBe('');
    expect(updateNote).not.toHaveBeenCalled();
    expect(deps.focusEditor).not.toHaveBeenCalled();
  });

  it('does not rewrite a CRLF note to disk just because it was opened', async () => {
    routeId = 'old note';
    vi.mocked(readNote).mockResolvedValueOnce('line one\r\nline two\r\n');
    const session = createNoteSession(makeDeps());
    await session.loadNote('old note');

    expect(session.content).toBe('line one\nline two\n');
    session.debouncedSave(editorContent);
    await vi.advanceTimersByTimeAsync(600);
    expect(updateNote).not.toHaveBeenCalled();
  });
});
