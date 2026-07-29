// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';

const noteMocks = vi.hoisted(() => ({
  getNoteById: vi.fn(),
  handleExternalFileChange: vi.fn(async () => {}),
  readNote: vi.fn(async () => ''),
  refreshNotesFromStorage: vi.fn(async () => {}),
}));

vi.mock('$features/notes/notes.svelte', () => noteMocks);
vi.mock('$lib/platform', () => ({ hasFileSystem: true }));

import { createExternalChangeCoordinator } from './createExternalChangeCoordinator';

interface SessionState {
  composing: boolean;
  dirty: boolean;
  editorContent: string;
  editorFocused: boolean;
  originalId: string | null;
  savedContent: string;
  savePending: boolean;
}

function makeSession(overrides: Partial<SessionState> = {}) {
  const state: SessionState = {
    composing: false,
    dirty: false,
    editorContent: 'local content',
    editorFocused: false,
    originalId: 'active',
    savedContent: 'local content',
    savePending: false,
    ...overrides,
  };
  const applyExternalContent = vi.fn((content: string) => {
    state.editorContent = content;
    state.savedContent = content;
  });
  const cancelAndClear = vi.fn(() => {
    state.originalId = null;
  });
  const session = {
    title: 'active',
    content: 'local content',
    get originalId() {
      return state.originalId;
    },
    titleWarning: '',
    loading: false,
    editVersion: 0,
    lastEditTime: 0,
    get savePending() {
      return state.savePending;
    },
    get savedContent() {
      return state.savedContent;
    },
    get dirty() {
      return state.dirty;
    },
    get editorContent() {
      return state.editorContent;
    },
    get editorFocused() {
      return state.editorFocused;
    },
    get composing() {
      return state.composing;
    },
    debouncedSave: vi.fn(),
    flushSave: vi.fn(async () => {}),
    runWithSaveLock: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
    loadNote: vi.fn(async () => {}),
    handleTitleInput: vi.fn(),
    handleTitleKeydown: vi.fn(),
    handleTitleFocus: vi.fn(),
    handleTitlePointerDown: vi.fn(),
    seedOpenNote: vi.fn(),
    cancelAndClear,
    applyExternalContent,
    applyRemoteRename: vi.fn(),
  } satisfies NoteSession;
  return { applyExternalContent, cancelAndClear, session, state };
}

function makeCoordinator(session: NoteSession) {
  const notifySaved = vi.fn();
  const showToast = vi.fn();
  const coordinator = createExternalChangeCoordinator({
    session,
    notifySaved,
    showToast,
    writeSuppressor: createWriteSuppressor(),
  });
  return { coordinator, notifySaved, showToast };
}

function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('createExternalChangeCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noteMocks.getNoteById.mockReturnValue({ id: 'active', title: 'active' });
    noteMocks.readNote.mockResolvedValue('');
  });

  it('drops a self-write echo that matches the saved baseline', async () => {
    noteMocks.readNote.mockResolvedValueOnce('saved content');
    const bundle = makeSession({
      editorContent: 'newer editor content',
      savedContent: 'saved content',
    });
    const { coordinator, notifySaved, showToast } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });

    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledWith('active.md');
    expect(notifySaved).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  it('adopts differing disk content even while the focused session is dirty', async () => {
    noteMocks.readNote.mockResolvedValueOnce('external content');
    const bundle = makeSession({ dirty: true, editorFocused: true });
    const { coordinator, showToast } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });

    expect(bundle.applyExternalContent).toHaveBeenCalledWith('external content');
    expect(showToast).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it('does not adopt a slow read after the user switches notes', async () => {
    const read = controlledPromise<string>();
    noteMocks.readNote.mockReturnValueOnce(read.promise);
    const bundle = makeSession();
    const { coordinator } = makeCoordinator(bundle.session);

    const handling = coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    bundle.state.originalId = 'other';
    read.resolve('active external content');
    await handling;

    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it('drops a slow read when a save becomes pending', async () => {
    const read = controlledPromise<string>();
    noteMocks.readNote.mockReturnValueOnce(read.promise);
    const bundle = makeSession();
    const { coordinator } = makeCoordinator(bundle.session);

    const handling = coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    bundle.state.savePending = true;
    read.resolve('external content');
    await handling;

    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it('adopts disk content matching the editor and advances the saved baseline', async () => {
    noteMocks.readNote.mockResolvedValueOnce('local content').mockResolvedValueOnce('old baseline');
    const bundle = makeSession({
      editorContent: 'local content',
      savedContent: 'old baseline',
    });
    const { coordinator } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });

    expect(bundle.applyExternalContent.mock.calls).toEqual([['local content'], ['old baseline']]);
    coordinator.stop();
  });

  it('defers adoption during composition and applies it silently on blur', async () => {
    noteMocks.readNote
      .mockResolvedValueOnce('external content')
      .mockResolvedValueOnce('external content');
    const bundle = makeSession({ composing: true, dirty: true, editorFocused: true });
    const { coordinator, showToast } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();

    bundle.state.composing = false;
    bundle.state.editorFocused = false;
    await coordinator.handleEditorFocusChange(false);

    expect(bundle.applyExternalContent).toHaveBeenCalledWith('external content');
    expect(showToast).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it('serializes watcher and blur reconciles so the latest disk content wins', async () => {
    const olderRead = controlledPromise<string>();
    const latestRead = controlledPromise<string>();
    noteMocks.readNote
      .mockReturnValueOnce(olderRead.promise)
      .mockReturnValueOnce(latestRead.promise);
    const bundle = makeSession();
    const { coordinator } = makeCoordinator(bundle.session);

    coordinator.deferAdopt('active');
    const watcherReconcile = coordinator.handleFileChange({
      type: 'change',
      filename: 'active.md',
    });
    const blurReconcile = coordinator.handleEditorFocusChange(false);

    latestRead.resolve('latest disk content');
    olderRead.resolve('older disk content');
    await Promise.all([watcherReconcile, blurReconcile]);

    expect(noteMocks.readNote).toHaveBeenCalledTimes(2);
    expect(bundle.applyExternalContent.mock.calls).toEqual([
      ['older disk content'],
      ['latest disk content'],
    ]);
    expect(bundle.state.editorContent).toBe('latest disk content');
    coordinator.stop();
  });

  it('closes the session when a change event reads empty content for a missing note', async () => {
    noteMocks.readNote.mockResolvedValueOnce('');
    noteMocks.getNoteById.mockReturnValueOnce(null);
    const bundle = makeSession({ dirty: true });
    const { coordinator, notifySaved, showToast } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });

    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledExactlyOnceWith('Note was deleted externally');
    expect(notifySaved).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  it('adopts empty content when the note still exists', async () => {
    noteMocks.readNote.mockResolvedValueOnce('');
    const bundle = makeSession({
      editorContent: 'existing content',
      savedContent: 'existing content',
    });
    const { coordinator, notifySaved, showToast } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });

    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(notifySaved).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  it('closes an open note deleted externally and shows the deletion toast', async () => {
    const bundle = makeSession({ dirty: true });
    const { coordinator, showToast } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'unlink', filename: 'active.md' });

    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledExactlyOnceWith('Note was deleted externally');
    coordinator.stop();
  });

  it('reconciles an active note after its direct read fails', async () => {
    noteMocks.readNote.mockRejectedValueOnce(new Error('transient read failure'));
    const bundle = makeSession();
    const { coordinator, notifySaved } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });

    expect(noteMocks.readNote).toHaveBeenCalledWith('active');
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledWith('active.md');
    expect(notifySaved).toHaveBeenCalledOnce();
    coordinator.stop();
  });
});

describe('deferred adopt identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noteMocks.getNoteById.mockReturnValue({ id: 'active', title: 'active' });
    noteMocks.readNote.mockResolvedValue('');
  });

  it('drops a deferred adopt after the session switches to another note', async () => {
    noteMocks.readNote.mockResolvedValueOnce('stale active content');
    const bundle = makeSession({ composing: true, editorFocused: true });
    const { coordinator } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    bundle.state.originalId = 'other';
    bundle.state.composing = false;
    bundle.state.editorFocused = false;
    await coordinator.handleEditorFocusChange(false);

    expect(noteMocks.readNote).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it('re-reads current disk content when a deferred note is reopened before blur', async () => {
    noteMocks.readNote
      .mockResolvedValueOnce('old external snapshot')
      .mockResolvedValueOnce('current disk content');
    const bundle = makeSession({ composing: true, editorFocused: true });
    const { coordinator } = makeCoordinator(bundle.session);

    await coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    bundle.state.originalId = 'other';
    bundle.state.originalId = 'active';
    bundle.state.composing = false;
    bundle.state.editorFocused = false;
    await coordinator.handleEditorFocusChange(false);

    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('current disk content');
    coordinator.stop();
  });
});
