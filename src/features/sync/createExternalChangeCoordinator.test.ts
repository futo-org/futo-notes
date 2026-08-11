// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSession } from '$features/notes/noteSession.svelte';
import { createWriteSuppressor } from '$lib/platform/writeSuppression';
import type { OpenNoteDispositionOutput, OpenNoteRequestInput } from './syncContract.generated';

const noteMocks = vi.hoisted(() => ({
  handleExternalFileChange: vi.fn(async () => {}),
  refreshNotesFromStorage: vi.fn(async () => {}),
}));
const syncMocks = vi.hoisted(() => ({
  classifyOpenNote: vi.fn<(facts: OpenNoteRequestInput) => Promise<OpenNoteDispositionOutput>>(),
}));

vi.mock('$features/notes/notes.svelte', () => noteMocks);
vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('./syncServiceE2ee', () => ({
  classifyOpenNote: syncMocks.classifyOpenNote,
}));

import { createExternalChangeCoordinator } from './createExternalChangeCoordinator';

interface SessionState {
  composing: boolean;
  dirty: boolean;
  editVersion: number;
  editorContent: string;
  editorFocused: boolean;
  originalId: string | null;
  savedContent: string;
  savePending: boolean;
  title: string;
}

function makeSession(overrides: Partial<SessionState> = {}) {
  const state: SessionState = {
    composing: false,
    dirty: false,
    editVersion: 0,
    editorContent: 'base',
    editorFocused: false,
    originalId: 'active',
    savedContent: 'base',
    savePending: false,
    title: 'active',
    ...overrides,
  };
  const applyExternalContent = vi.fn((content: string) => {
    state.editorContent = content;
    state.savedContent = content;
  });
  const rebaseSavedContent = vi.fn((content: string) => {
    state.savedContent = content;
  });
  const applyRemoteRename = vi.fn((id: string, title: string) => {
    state.originalId = id;
    state.title = title;
  });
  const cancelAndClear = vi.fn(() => {
    state.originalId = null;
  });
  const session = {
    get title() {
      return state.title;
    },
    content: 'base',
    get originalId() {
      return state.originalId;
    },
    titleWarning: '',
    loading: false,
    get editVersion() {
      return state.editVersion;
    },
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
    resumeDraftPersistence: vi.fn(),
    flushSave: vi.fn(async () => {}),
    awaitSaveIdle: vi.fn(async () => {}),
    runWithSaveLock: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
    loadNote: vi.fn(async () => {}),
    handleTitleInput: vi.fn(),
    handleTitleKeydown: vi.fn(),
    handleTitleFocus: vi.fn(),
    handleTitlePointerDown: vi.fn(),
    seedOpenNote: vi.fn(),
    cancelAndClear,
    applyExternalContent,
    rebaseSavedContent,
    applyRemoteRename,
  } satisfies NoteSession;
  return {
    applyExternalContent,
    applyRemoteRename,
    cancelAndClear,
    rebaseSavedContent,
    session,
    state,
  };
}

function makeCoordinator(sessionBundle = makeSession(), writeSuppressor = createWriteSuppressor()) {
  const notifySaved = vi.fn();
  const showToast = vi.fn();
  const followRename = vi.fn((fromId: string, toId: string) => {
    if (sessionBundle.state.originalId === fromId) {
      sessionBundle.state.originalId = toId;
    }
  });
  const coordinator = createExternalChangeCoordinator({
    followRename,
    session: sessionBundle.session,
    notifySaved,
    showToast,
    writeSuppressor,
  });
  return {
    coordinator,
    followRename,
    notifySaved,
    showToast,
    ...sessionBundle,
  };
}

function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  syncMocks.classifyOpenNote.mockResolvedValue({ kind: 'leave' });
});

describe('engine-owned open-note disposition', () => {
  it('sends one complete editor snapshot and no frontend disk value', async () => {
    const bundle = makeCoordinator(
      makeSession({
        editorContent: 'draft',
        editorFocused: true,
        savedContent: 'base',
      }),
    );

    await bundle.coordinator.reconcileOpenNote('active', {
      editedDuringCycle: true,
      renamedTo: 'renamed',
    });

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledExactlyOnceWith({
      id: 'active',
      base: 'base',
      draft: 'draft',
      renamedTo: 'renamed',
      editorFocused: true,
      editedDuringCycle: true,
    });
    bundle.coordinator.stop();
  });

  it.each([
    [{ kind: 'leave' } as const, 'leave'],
    [{ kind: 'adopt', content: 'peer' } as const, 'adopt'],
    [{ kind: 'deferAdopt' } as const, 'deferAdopt'],
    [{ kind: 'followRename', toId: 'renamed' } as const, 'followRename'],
    [{ kind: 'keepDraft', base: 'peer', reason: 'diverged' } as const, 'keepDraft'],
    [{ kind: 'close' } as const, 'close'],
  ])('applies the %s verdict through the one executor', async (disposition, kind) => {
    syncMocks.classifyOpenNote.mockResolvedValueOnce(disposition);
    const bundle = makeCoordinator();

    const result = await bundle.coordinator.reconcileOpenNote('active');

    expect(result.disposition).toBe(kind);
    if (kind === 'adopt') {
      expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('peer');
    } else if (kind === 'followRename') {
      expect(bundle.followRename).toHaveBeenCalledExactlyOnceWith('active', 'renamed');
    } else if (kind === 'keepDraft') {
      expect(bundle.rebaseSavedContent).toHaveBeenCalledExactlyOnceWith('peer');
      expect(bundle.session.resumeDraftPersistence).toHaveBeenCalledOnce();
    } else if (kind === 'close') {
      expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    }
    bundle.coordinator.stop();
  });

  it('uses one desktop wording for a peer-deleted draft and rebases it', async () => {
    syncMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'base',
      reason: 'peerDeleted',
    });
    const bundle = makeCoordinator(makeSession({ editorContent: 'draft' }));

    const result = await bundle.coordinator.reconcileOpenNote('active');

    expect(result.keptDraftId).toBe('active');
    expect(bundle.rebaseSavedContent).toHaveBeenCalledExactlyOnceWith('base');
    expect(bundle.session.resumeDraftPersistence).toHaveBeenCalledOnce();
    expect(bundle.showToast).toHaveBeenCalledExactlyOnceWith(
      'Open note was deleted; keeping local draft',
    );
    bundle.coordinator.stop();
  });

  it('defers a focused adopt and reclassifies on blur', async () => {
    syncMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'deferAdopt' })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'latest' });
    const bundle = makeCoordinator(makeSession({ editorFocused: true }));

    await bundle.coordinator.reconcileOpenNote('active');
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();

    bundle.state.editorFocused = false;
    await bundle.coordinator.handleEditorFocusChange(false);

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledTimes(2);
    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('latest');
    bundle.coordinator.stop();
  });

  it('never adopts over work typed after the deferral, and re-gathers when it settles', async () => {
    // The failure this guards: a deferral that remembers CONTENT instead of
    // intent. The peer's bytes are captured while the editor is clean, the user
    // then types, and blur applies the remembered adopt over the new draft.
    // Nothing may reach the buffer until the draft is settled, and the pass
    // that finally settles must classify the draft as it is THEN.
    syncMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'deferAdopt' })
      .mockResolvedValueOnce({ kind: 'leave' });
    const bundle = makeCoordinator(makeSession({ editorFocused: true }));

    await bundle.coordinator.reconcileOpenNote('active');
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();

    // The user types before blurring: the draft is dirty and its save has not
    // landed, so the deferral has to wait rather than resolve against it.
    bundle.state.editorContent = 'base typed';
    bundle.state.editVersion += 1;
    bundle.state.dirty = true;
    bundle.state.editorFocused = false;
    await bundle.coordinator.handleEditorFocusChange(false);

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();

    // The engine persists or parks that draft (here: persisted), and the next
    // edge settles the retained deferral against the draft as it is now.
    bundle.state.dirty = false;
    bundle.state.savedContent = 'base typed';
    await bundle.coordinator.handleEditorFocusChange(false);

    expect(syncMocks.classifyOpenNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'active', base: 'base typed', draft: 'base typed' }),
    );
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    bundle.coordinator.stop();
  });

  it('classifies the exact parked snapshot as preserved, but protects a later edit', async () => {
    const parked = { content: 'parked draft', title: 'active' };
    const first = makeCoordinator(
      makeSession({ editorContent: parked.content, savedContent: 'old base' }),
    );
    await first.coordinator.reconcileOpenNote('active', { parkedDraft: parked });
    expect(syncMocks.classifyOpenNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ base: parked.content, draft: parked.content }),
    );
    first.coordinator.stop();

    const second = makeCoordinator(
      makeSession({ editorContent: 'later edit', savedContent: 'old base' }),
    );
    await second.coordinator.reconcileOpenNote('active', { parkedDraft: parked });
    expect(syncMocks.classifyOpenNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ base: 'old base', draft: 'later edit' }),
    );
    second.coordinator.stop();
  });
});

describe('single stale-snapshot revalidation', () => {
  it.each([
    ['identity', (state: SessionState) => (state.originalId = 'other')],
    ['edit version', (state: SessionState) => (state.editVersion += 1)],
    ['draft', (state: SessionState) => (state.editorContent = 'new edit')],
    ['title', (state: SessionState) => (state.title = 'new title')],
    ['focus', (state: SessionState) => (state.editorFocused = true)],
  ])('does not apply an adopt after the %s changes during classification', async (_, mutate) => {
    const verdict = controlledPromise<OpenNoteDispositionOutput>();
    syncMocks.classifyOpenNote.mockReturnValueOnce(verdict.promise);
    const bundle = makeCoordinator();

    const reconciliation = bundle.coordinator.reconcileOpenNote('active');
    await Promise.resolve();
    mutate(bundle.state);
    verdict.resolve({ kind: 'adopt', content: 'peer' });

    await expect(reconciliation).resolves.toMatchObject({ stale: true });
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    bundle.coordinator.stop();
  });

  it('serializes overlapping classifications so the later verdict wins', async () => {
    const first = controlledPromise<OpenNoteDispositionOutput>();
    syncMocks.classifyOpenNote
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'adopt', content: 'later' });
    const bundle = makeCoordinator();

    const earlier = bundle.coordinator.reconcileOpenNote('active');
    const later = bundle.coordinator.reconcileOpenNote('active');
    await Promise.resolve();
    expect(syncMocks.classifyOpenNote).toHaveBeenCalledTimes(1);
    first.resolve({ kind: 'adopt', content: 'earlier' });
    await Promise.all([earlier, later]);

    expect(bundle.applyExternalContent.mock.calls).toEqual([['earlier'], ['later']]);
    bundle.coordinator.stop();
  });

  it('does not apply a verdict after the coordinator stops', async () => {
    const verdict = controlledPromise<OpenNoteDispositionOutput>();
    syncMocks.classifyOpenNote.mockReturnValueOnce(verdict.promise);
    const bundle = makeCoordinator();

    const reconciliation = bundle.coordinator.reconcileOpenNote('active');
    await Promise.resolve();
    bundle.coordinator.stop();
    verdict.resolve({ kind: 'adopt', content: 'peer' });
    await reconciliation;

    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
  });

  it('retains a failed classification for the next blur', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    syncMocks.classifyOpenNote
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({ kind: 'adopt', content: 'peer' });
    const bundle = makeCoordinator(makeSession({ editorFocused: true }));

    await bundle.coordinator.reconcileOpenNote('active');
    bundle.state.editorFocused = false;
    await bundle.coordinator.handleEditorFocusChange(false);

    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('peer');
    warn.mockRestore();
    bundle.coordinator.stop();
  });
});

describe('save, composition, and watcher ordering', () => {
  it('settles a pending save before gathering facts', async () => {
    const save = controlledPromise<void>();
    const bundle = makeCoordinator(makeSession({ savePending: true }));
    vi.mocked(bundle.session.flushSave).mockImplementationOnce(async () => {
      await save.promise;
      bundle.state.savePending = false;
      bundle.state.savedContent = 'saved draft';
      bundle.state.editorContent = 'saved draft';
    });

    const reconciliation = bundle.coordinator.reconcileOpenNote('active');
    await Promise.resolve();
    expect(syncMocks.classifyOpenNote).not.toHaveBeenCalled();
    save.resolve();
    await reconciliation;

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'saved draft', draft: 'saved draft' }),
    );
    bundle.coordinator.stop();
  });

  it('defers a composing watcher change until composition ends', async () => {
    syncMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'adopt', content: 'peer' });
    const bundle = makeCoordinator(
      makeSession({ composing: true, editorFocused: true, savePending: true }),
    );

    await bundle.coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    expect(syncMocks.classifyOpenNote).not.toHaveBeenCalled();
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledWith('active.md');

    bundle.state.composing = false;
    bundle.state.editorFocused = false;
    bundle.state.savePending = false;
    await bundle.coordinator.handleCompositionEnd();

    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('peer');
    bundle.coordinator.stop();
  });

  it('routes an external unlink through the engine instead of closing locally', async () => {
    syncMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'base',
      reason: 'peerDeleted',
    });
    const bundle = makeCoordinator(makeSession({ editorContent: 'draft' }));

    await bundle.coordinator.handleFileChange({ type: 'unlink', filename: 'active.md' });

    expect(syncMocks.classifyOpenNote).toHaveBeenCalledOnce();
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(bundle.rebaseSavedContent).toHaveBeenCalledWith('base');
    bundle.coordinator.stop();
  });

  it('keeps suppressing non-active sync writes while active changes still classify', async () => {
    const suppressor = createWriteSuppressor();
    suppressor.recordSyncWrite('background.md');
    suppressor.recordSyncWrite('active.md');
    const bundle = makeCoordinator(makeSession(), suppressor);

    await bundle.coordinator.handleFileChange({ type: 'change', filename: 'background.md' });
    expect(noteMocks.handleExternalFileChange).not.toHaveBeenCalled();

    await bundle.coordinator.handleFileChange({ type: 'change', filename: 'active.md' });
    expect(syncMocks.classifyOpenNote).toHaveBeenCalledOnce();
    expect(noteMocks.handleExternalFileChange).toHaveBeenCalledWith('active.md');
    bundle.coordinator.stop();
  });
});
