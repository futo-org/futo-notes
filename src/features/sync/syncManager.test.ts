// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let autoSyncCallbacks: import('./autoSyncV2').AutoSyncCallbacks | null = null;
const tauriEventMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
const openNoteMocks = vi.hoisted(() => ({
  classifyOpenNote: vi.fn(),
}));
vi.mock('./autoSyncV2', () => ({
  startAutoSyncV2: (callbacks: import('./autoSyncV2').AutoSyncCallbacks) => {
    autoSyncCallbacks = callbacks;
  },
  stopAutoSyncV2: vi.fn(),
  notifySavedV2: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    tauriEventMocks.listeners.set(event, listener);
    return () => tauriEventMocks.listeners.delete(event);
  }),
}));
vi.mock('./syncServiceE2ee', () => ({
  classifyOpenNote: openNoteMocks.classifyOpenNote,
}));
vi.mock('$lib/platform', () => ({ hasFileSystem: true, isTauri: true }));
vi.mock('$shared/state/appState', () => ({ updateAppState: vi.fn(async () => {}) }));
const rescanLocalNotes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/localNoteStore', () => ({
  getLocalNoteStore: vi.fn(async () => ({ rescan: rescanLocalNotes })),
}));
vi.mock('$features/notes/notes.svelte', () => ({
  updateNote: vi.fn(async (id: string) => ({ id, mtime: 0, disposition: 'wrote' })),
  noteExists: vi.fn(async () => false),
  getNoteById: vi.fn(() => undefined),
  handleExternalFileChange: vi.fn(async () => {}),
  refreshNotesFromStorage: vi.fn(async () => {}),
}));

import { updateAppState } from '$shared/state/appState';
import { noteExists, refreshNotesFromStorage, updateNote } from '$features/notes/notes.svelte';
import {
  createNoteSession,
  type NoteSession,
  type NoteSessionDeps,
} from '$features/notes/noteSession.svelte';
import { writeSuppressor } from '$lib/platform/writeSuppression';
import { createSyncManager, getSyncErrorMessage, type SyncManagerDeps } from './syncManager.svelte';
import type { SyncSummary } from './syncServiceE2ee';

const emptySummary: SyncSummary = {
  uploaded: 0,
  downloaded: 0,
  deleted: 0,
  conflicts: 0,
  failures: [],
  failureMessage: null,
  updatedIds: [],
  deletedIds: [],
  renamed: [],
  peerUpdatedIds: [],
  peerDeletedIds: [],
};

type SessionState = {
  id: string | null;
  content: string | undefined;
  savedContent: string;
  dirty: boolean;
  focused: boolean;
  composing: boolean;
  savePending: boolean;
  editVersion: number;
  lastEditTime: number;
  title: string;
};

function makeSession(overrides: Partial<SessionState> = {}) {
  const state: SessionState = {
    id: null,
    content: undefined,
    savedContent: '',
    dirty: false,
    focused: false,
    composing: false,
    savePending: false,
    editVersion: 0,
    lastEditTime: 0,
    title: overrides.id ?? '',
    ...overrides,
  };
  if (overrides.savedContent === undefined) state.savedContent = state.content ?? '';
  const applyExternalContent = vi.fn((content: string) => {
    state.content = content;
    state.savedContent = content;
  });
  const rebaseSavedContent = vi.fn((content: string) => {
    state.savedContent = content;
  });
  const applyRemoteRename = vi.fn((id: string) => {
    state.id = id;
  });
  const cancelAndClear = vi.fn(() => {
    state.id = null;
  });
  const awaitSaveIdle = vi.fn(async () => {});
  const session = {
    get title() {
      return state.title;
    },
    get originalId() {
      return state.id;
    },
    get editorContent() {
      return state.content;
    },
    get savedContent() {
      return state.savedContent;
    },
    get dirty() {
      return state.dirty;
    },
    get editorFocused() {
      return state.focused;
    },
    get composing() {
      return state.composing;
    },
    get savePending() {
      return state.savePending;
    },
    get editVersion() {
      return state.editVersion;
    },
    get lastEditTime() {
      return state.lastEditTime;
    },
    flushSave: vi.fn(async () => {}),
    awaitSaveIdle,
    applyExternalContent,
    rebaseSavedContent,
    applyRemoteRename,
    cancelAndClear,
  } as unknown as NoteSession;
  return {
    state,
    session,
    applyExternalContent,
    rebaseSavedContent,
    applyRemoteRename,
    awaitSaveIdle,
    cancelAndClear,
  };
}

function makeManager(
  sessionBundle = makeSession(),
  overrides: Partial<Omit<SyncManagerDeps, 'session'>> = {},
) {
  const toasts: string[] = [];
  const onRename = vi.fn();
  const pruneTabsForDeletedIds = vi.fn();
  const manager = createSyncManager({
    session: sessionBundle.session,
    showToast: (message) => toasts.push(message),
    onRename,
    pruneTabsForDeletedIds,
    ...overrides,
  });
  return { manager, toasts, onRename, pruneTabsForDeletedIds, ...sessionBundle };
}

function makeLiveNoteSession(id: string, body: string) {
  let editorContent = body;
  const setEditorContent = vi.fn((content: string) => {
    editorContent = content;
  });
  const deps = {
    getEditorContent: () => editorContent,
    setEditorContent,
    focusEditor: vi.fn(),
    isEditorFocused: () => false,
    isComposing: () => false,
    getNotes: () => [],
    getNoteBody: () => undefined,
    getTitleTextarea: () => undefined,
    getNoteId: () => id,
    setPrevNoteId: vi.fn(),
    onNoteRenamed: vi.fn(),
    reconcileOpenNote: vi.fn(async () => false),
    navigate: vi.fn(),
  } satisfies NoteSessionDeps;
  const session = createNoteSession(deps);
  session.seedOpenNote(id, body);
  setEditorContent.mockClear();

  return {
    session,
    setEditorContent,
    getEditorContent: () => editorContent,
    editContent: (content: string) => {
      editorContent = content;
      session.debouncedSave(content);
    },
  };
}

function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function yieldMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  autoSyncCallbacks = null;
  tauriEventMocks.listeners.clear();
  vi.mocked(noteExists).mockReset();
  vi.mocked(noteExists).mockResolvedValue(false);
  vi.mocked(refreshNotesFromStorage).mockClear();
  vi.mocked(updateNote).mockReset();
  vi.mocked(updateNote).mockImplementation(async (id: string) => ({
    id,
    mtime: 0,
    disposition: 'wrote',
  }));
  rescanLocalNotes.mockClear();
  vi.mocked(updateAppState).mockClear();
  openNoteMocks.classifyOpenNote.mockReset();
  openNoteMocks.classifyOpenNote.mockResolvedValue({ kind: 'leave' });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sync outcome state', () => {
  it('rewrites opaque fetch TypeErrors to an actionable message', () => {
    expect(getSyncErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Could not reach server/);
  });

  it('surfaces a background error and clears it on the next clean cycle', async () => {
    const { manager } = makeManager();
    const cleanup = manager.start();
    autoSyncCallbacks!.onSyncError(new TypeError('Load failed'));
    expect(manager.syncErrorMessage).toMatch(/Could not reach server/);

    await autoSyncCallbacks!.onSyncComplete(emptySummary, 'poll');
    expect(manager.syncError).toBe(false);
    cleanup();
  });

  it('toasts once per distinct failure message and re-arms after a clean cycle', async () => {
    const { manager, toasts } = makeManager();
    const failure = (code: number): SyncSummary => ({
      ...emptySummary,
      failures: [{ filename: 'note.md', kind: 'upload', statusCode: code }],
      failureMessage: `1 change couldn't reach the server (HTTP ${code})`,
    });

    await manager.handleSyncComplete(failure(500), 'poll');
    await manager.handleSyncComplete(failure(500), 'poll');
    await manager.handleSyncComplete(failure(403), 'poll');
    await manager.handleSyncComplete(emptySummary, 'poll');
    await manager.handleSyncComplete(failure(500), 'poll');

    expect(toasts).toEqual([
      "Sync error: 1 change couldn't reach the server (HTTP 500)",
      "Sync error: 1 change couldn't reach the server (HTTP 403)",
      "Sync error: 1 change couldn't reach the server (HTTP 500)",
    ]);
  });

  it('a clean poll cannot clear or re-toast a still-broken stream', async () => {
    const { manager, toasts } = makeManager();
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    await manager.handleSyncComplete(emptySummary, 'poll');
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    expect(manager.syncError).toBe(true);
    expect(toasts).toEqual(['Sync error: stream lost']);
  });

  it('a stream reconnect clears stream errors while a cycle error keeps live true', () => {
    const { manager } = makeManager();
    manager.handleLiveState({ live: true, status: 'cycle-error', message: 'HTTP 500' });
    expect(manager.live).toBe(true);
    expect(manager.syncError).toBe(true);
    manager.handleLiveState({ live: true, status: 'connected' });
    // Connected only clears stream errors; the cycle error remains until a clean cycle.
    expect(manager.syncError).toBe(true);

    manager.clearSyncError();
    manager.handleLiveState({ live: false, status: 'reconnecting', message: 'stream lost' });
    manager.handleLiveState({ live: true, status: 'connected' });
    expect(manager.syncError).toBe(false);
  });

  it('manual clean cycles are the only clean cycles that toast completion', async () => {
    const { manager, toasts } = makeManager();
    await manager.handleSyncComplete(emptySummary, 'poll');
    await manager.handleSyncComplete(emptySummary);
    await manager.handleSyncComplete(emptySummary, 'manual');
    expect(toasts).toEqual(['Sync complete']);
  });

  it('stamps lastSyncedAt for every completed cycle', async () => {
    const { manager } = makeManager();
    await manager.handleSyncComplete(emptySummary, 'poll');
    expect(updateAppState).toHaveBeenCalledWith({ lastSyncedAt: expect.any(Number) });
  });
});

describe('peer projections', () => {
  it('reconciles the owned index once for a peer-driven batch', async () => {
    const { manager } = makeManager();
    await manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Peer', 'Mine'],
      deletedIds: ['Gone'],
      peerUpdatedIds: ['Peer'],
      peerDeletedIds: ['Gone'],
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });
    expect(rescanLocalNotes).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile the owned index for a pure push echo', async () => {
    const { manager } = makeManager();
    await manager.handleSyncComplete({ ...emptySummary, updatedIds: ['Mine'] });
    expect(rescanLocalNotes).not.toHaveBeenCalled();
  });

  // Rename intent is engine-reported (including collision placements — see
  // collision_placement_reports_the_relocated_local_note_as_a_rename in
  // futo-notes-sync); this only guards the tab-follow wiring for a
  // reported rename.
  it('follows a reported collision-placement rename before pruning deletions', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'followRename',
      toId: 'Old (conflict deadbeef)',
    });
    vi.mocked(noteExists).mockImplementation(async (id) => id !== 'Gone');
    const bundle = makeManager(makeSession({ id: 'Old', content: 'body' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Old'],
      deletedIds: ['Gone'],
      peerUpdatedIds: ['Old'],
      peerDeletedIds: ['Gone'],
      renamed: [{ fromId: 'Old', toId: 'Old (conflict deadbeef)' }],
    });
    expect(bundle.onRename).toHaveBeenCalledWith(
      'Old',
      'Old (conflict deadbeef)',
      'Old (conflict deadbeef)',
    );
    expect(bundle.applyRemoteRename).toHaveBeenCalledWith(
      'Old (conflict deadbeef)',
      'Old (conflict deadbeef)',
    );
    // The follow rebinds the session; the relocated draft is not adopted over.
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Gone']);
    expect(bundle.onRename.mock.invocationCallOrder[0]).toBeLessThan(
      bundle.pruneTabsForDeletedIds.mock.invocationCallOrder[0],
    );
  });

  it('waits for an in-flight save to commit before rebinding a remote rename', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'followRename',
      toId: 'New',
    });
    const sessionBundle = makeSession({
      id: 'Old',
      content: 'draft',
      savedContent: 'base',
      savePending: true,
    });
    let releaseSave!: () => void;
    const saveIdle = new Promise<void>((resolve) => {
      releaseSave = () => {
        sessionBundle.state.savedContent = 'draft';
        sessionBundle.state.savePending = false;
        resolve();
      };
    });
    vi.mocked(sessionBundle.session.flushSave).mockReturnValueOnce(saveIdle);
    const bundle = makeManager(sessionBundle);

    const reconciliation = bundle.manager.handleSyncComplete({
      ...emptySummary,
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });
    await yieldMicrotasks();

    expect(bundle.applyRemoteRename).not.toHaveBeenCalled();
    expect(bundle.state.savedContent).toBe('base');

    releaseSave();
    await reconciliation;

    expect(bundle.state.savedContent).toBe('draft');
    expect(bundle.applyRemoteRename).toHaveBeenCalledExactlyOnceWith('New', 'New');
  });

  it('does not rebind a remote rename after the session switches notes', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'followRename',
      toId: 'New',
    });
    const sessionBundle = makeSession({ id: 'Old', savePending: true });
    let releaseSave!: () => void;
    vi.mocked(sessionBundle.session.flushSave).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseSave = resolve;
      }),
    );
    const bundle = makeManager(sessionBundle);

    const reconciliation = bundle.manager.handleSyncComplete({
      ...emptySummary,
      renamed: [{ fromId: 'Old', toId: 'New' }],
    });
    await yieldMicrotasks();
    sessionBundle.state.id = 'Other';
    releaseSave();
    await reconciliation;

    expect(bundle.applyRemoteRename).not.toHaveBeenCalled();
  });

  // Same-cycle collision placement + tombstone of the relocated note: the
  // engine reports both the rename and the deletion of its target (guarded by
  // same_cycle_tombstone_of_a_collision_relocated_note_survives_ghost_stripping
  // in futo-notes-sync). The tab follows the rename, then the deleted-during-
  // sync flow closes it instead of leaving the editor bound to a nonexistent
  // note whose next save would resurrect the tombstoned object.
  it('closes the open note when a followed rename target was tombstoned in the same cycle', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({
        kind: 'followRename',
        toId: 'Old (conflict deadbeef)',
      })
      .mockResolvedValueOnce({ kind: 'close' });
    const bundle = makeManager(makeSession({ id: 'Old', content: 'body' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Old'],
      deletedIds: ['Old (conflict deadbeef)'],
      peerUpdatedIds: ['Old'],
      peerDeletedIds: ['Old (conflict deadbeef)'],
      renamed: [{ fromId: 'Old', toId: 'Old (conflict deadbeef)' }],
    });
    expect(bundle.applyRemoteRename).toHaveBeenCalledWith(
      'Old (conflict deadbeef)',
      'Old (conflict deadbeef)',
    );
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.toasts).toContain('Note was deleted');
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Old (conflict deadbeef)']);
  });

  // Same-cycle collision placement + a real peer edit to the relocated object:
  // the engine reports the rename AND keeps the update against its target id
  // (guarded by same_cycle_update_of_a_collision_relocated_note_survives_ghost_stripping
  // in futo-notes-sync). The tab follows the rename, then the fresh peer content
  // is adopted — without it the editor keeps the stale relocated draft and the
  // next save overwrites the peer edit on every client.
  it('reloads a followed rename target that also received a real update in the same cycle', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({
        kind: 'followRename',
        toId: 'Old (conflict deadbeef)',
      })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' });
    const bundle = makeManager(makeSession({ id: 'Old', content: 'stale' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Old (conflict deadbeef)'],
      peerUpdatedIds: ['Old (conflict deadbeef)'],
      renamed: [{ fromId: 'Old', toId: 'Old (conflict deadbeef)' }],
    });
    expect(bundle.applyRemoteRename).toHaveBeenCalledWith(
      'Old (conflict deadbeef)',
      'Old (conflict deadbeef)',
    );
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });
});

// eslint-disable-next-line max-lines-per-function -- One editor reconciliation matrix shares the manager/session harness.
describe('editor reconciliation', () => {
  it('rebases a draft saved during sync so the next flush persists it over pulled content', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: '# Remote update',
      reason: 'diverged',
    });
    const live = makeLiveNoteSession('During sync', 'base');
    const manager = createSyncManager({
      session: live.session,
      showToast: vi.fn(),
      onRename: vi.fn(),
      pruneTabsForDeletedIds: vi.fn(),
    });
    const cleanup = manager.start();
    autoSyncCallbacks!.onSyncStateChange(true);

    live.editContent('local draft');
    await live.session.flushSave();
    expect(live.session.savedContent).toBe('local draft');
    expect(live.session.editVersion).toBe(1);

    vi.mocked(updateNote).mockClear();
    await manager.handleSyncComplete({ ...emptySummary, updatedIds: ['During sync'] });

    expect(live.getEditorContent()).toBe('local draft');
    expect(live.session.savedContent).toBe('# Remote update');
    expect(live.session.dirty).toBe(true);

    await live.session.flushSave();

    expect(updateNote).toHaveBeenCalledExactlyOnceWith(
      'During sync',
      'During sync',
      'local draft',
      { originalId: 'During sync', base: '# Remote update' },
    );
    expect(live.session.savedContent).toBe('local draft');
    expect(live.session.dirty).toBe(false);
    cleanup();
  });

  it('adopts a live pull when no edits landed since the previous live completion', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'adopt',
      content: 'peer content',
    });
    const live = makeLiveNoteSession('Live pull', 'old content');
    live.editContent('already synced content');
    await live.session.flushSave();
    expect(live.session.editVersion).toBe(1);
    expect(live.session.dirty).toBe(false);

    const manager = createSyncManager({
      session: live.session,
      showToast: vi.fn(),
      onRename: vi.fn(),
      pruneTabsForDeletedIds: vi.fn(),
    });
    const cleanup = manager.start();
    const liveSynced = tauriEventMocks.listeners.get('sync:live-synced');
    expect(liveSynced).toBeDefined();

    // The previous live completion advances the epoch past the historical edit.
    liveSynced!({ payload: { ...emptySummary } });
    await yieldMicrotasks();

    liveSynced!({ payload: { ...emptySummary, updatedIds: ['Live pull'] } });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('peer content');
    expect(live.session.savedContent).toBe('peer content');
    expect(live.session.dirty).toBe(false);
    cleanup();
  });

  it('protects an edit that raced the live cycle start against the pulled content', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: '# Remote update',
      reason: 'diverged',
    });
    const live = makeLiveNoteSession('Race window', 'old content');
    const manager = createSyncManager({
      session: live.session,
      showToast: vi.fn(),
      onRename: vi.fn(),
      pruneTabsForDeletedIds: vi.fn(),
    });
    const cleanup = manager.start();

    // Edit + autosave land while a live cycle already runs in Rust; no
    // completion boundary has advanced the live epoch past them. A late
    // cycle-start capture must not reclassify the edit as pre-cycle.
    live.editContent('draft in the race window');
    await live.session.flushSave();
    expect(live.session.dirty).toBe(false);

    tauriEventMocks.listeners.get('sync:live-synced')!({
      payload: { ...emptySummary, updatedIds: ['Race window'] },
    });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('draft in the race window');
    expect(live.session.savedContent).toBe('# Remote update');
    expect(live.session.dirty).toBe(true);
    cleanup();
  });

  it('advances the live epoch at completion arrival, not after its processing', async () => {
    const live = makeLiveNoteSession('Queued arrival', 'old content');
    const manager = createSyncManager({
      session: live.session,
      showToast: vi.fn(),
      onRename: vi.fn(),
      pruneTabsForDeletedIds: vi.fn(),
    });
    const cleanup = manager.start();
    const liveSynced = tauriEventMocks.listeners.get('sync:live-synced')!;

    // Completion 1 stalls on its disk read while the user edits and saves.
    const verdict = controlledPromise<{
      kind: 'keepDraft';
      base: string;
      reason: 'diverged';
    }>();
    openNoteMocks.classifyOpenNote.mockReturnValueOnce(verdict.promise);
    liveSynced({ payload: { ...emptySummary, updatedIds: ['Queued arrival'] } });
    live.editContent('draft during processing');
    await live.session.flushSave();
    verdict.resolve({ kind: 'keepDraft', base: 'remote 1', reason: 'diverged' });
    await yieldMicrotasks();
    expect(live.session.savedContent).toBe('remote 1');

    // The rebased draft persists; the session is clean again.
    await live.session.flushSave();
    expect(live.session.dirty).toBe(false);
    expect(live.session.savedContent).toBe('draft during processing');

    // Completion 2's epoch was captured at completion 1's ARRIVAL — before the
    // edit — so the pulled content must be protected against, not adopted. An
    // epoch captured after completion 1's processing would misclassify the
    // edit as pre-cycle and adopt 'remote 2' over the draft.
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'remote 2',
      reason: 'diverged',
    });
    liveSynced({ payload: { ...emptySummary, updatedIds: ['Queued arrival'] } });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('draft during processing');
    expect(live.session.savedContent).toBe('remote 2');
    expect(live.session.dirty).toBe(true);
    cleanup();
  });

  it('does not advance the live epoch on connect, protecting offline edits', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'peer content',
      reason: 'diverged',
    });
    const live = makeLiveNoteSession('Offline edit', 'old content');
    const manager = createSyncManager({
      session: live.session,
      showToast: vi.fn(),
      onRename: vi.fn(),
      pruneTabsForDeletedIds: vi.fn(),
    });
    const cleanup = manager.start();

    live.editContent('edited while offline');
    await live.session.flushSave();
    expect(live.session.dirty).toBe(false);

    // A connect capture would classify the offline edit as pre-cycle and let
    // the first pull adopt over it.
    manager.handleLiveState({ live: true, status: 'connected' });

    tauriEventMocks.listeners.get('sync:live-synced')!({
      payload: { ...emptySummary, updatedIds: ['Offline edit'] },
    });
    await yieldMicrotasks();

    expect(live.getEditorContent()).toBe('edited while offline');
    expect(live.session.savedContent).toBe('peer content');
    expect(live.session.dirty).toBe(true);
    cleanup();
  });

  it('keeps the live epoch independent of a JS cycle capture', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'peer content',
      reason: 'diverged',
    });
    const bundle = makeManager(
      makeSession({ id: 'Epoch overlap', content: 'old content', editVersion: 1 }),
    );
    const cleanup = bundle.manager.start();

    // The JS cycle captures its own epoch at the current edit version; the
    // live epoch stays at its last completion boundary (0).
    autoSyncCallbacks!.onSyncStateChange(true);
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Epoch overlap'],
    });

    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    expect(bundle.rebaseSavedContent).toHaveBeenCalledWith('peer content');
    cleanup();
  });

  it('settles an in-flight parked save before deciding how to reconcile pulled content', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'adopt', content: 'peer content' })
      .mockResolvedValueOnce({ kind: 'leave' });
    const save = controlledPromise<void>();
    const bundle = makeManager(
      makeSession({
        id: 'Save race',
        content: 'local draft',
        savedContent: 'old base',
        dirty: true,
        savePending: true,
      }),
    );
    vi.mocked(bundle.session.flushSave).mockImplementationOnce(async () => {
      await save.promise;
      await bundle.manager.reconcileOpenNote('Save race', {
        content: 'local draft',
        title: 'Save race',
      });
      bundle.state.savePending = false;
      bundle.state.dirty = false;
    });

    const reconciliation = bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Save race'],
    });
    await yieldMicrotasks();

    expect(bundle.session.flushSave).toHaveBeenCalledOnce();
    expect(openNoteMocks.classifyOpenNote).not.toHaveBeenCalled();
    expect(bundle.rebaseSavedContent).not.toHaveBeenCalled();

    save.resolve();
    await reconciliation;

    expect(bundle.applyExternalContent).toHaveBeenCalledWith('peer content');
    expect(bundle.state.content).toBe('peer content');
    expect(bundle.state.savedContent).toBe('peer content');
  });

  it('serializes overlapping completions so the later cycle content wins', async () => {
    const firstVerdict = controlledPromise<{ kind: 'adopt'; content: string }>();
    openNoteMocks.classifyOpenNote
      .mockReturnValueOnce(firstVerdict.promise)
      .mockResolvedValueOnce({ kind: 'adopt', content: 'later cycle content' });
    const bundle = makeManager(makeSession({ id: 'Overlap', content: 'base' }));

    const first = bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Overlap'],
    });
    const second = bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Overlap'],
    });
    await yieldMicrotasks();

    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledTimes(1);
    firstVerdict.resolve({ kind: 'adopt', content: 'earlier cycle content' });
    await Promise.all([first, second]);

    expect(bundle.applyExternalContent.mock.calls).toEqual([
      ['earlier cycle content'],
      ['later cycle content'],
    ]);
    expect(bundle.state.content).toBe('later cycle content');
  });

  it('silently rebases when pulled content already matches the editor', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'converged content',
      reason: 'converged',
    });
    const live = makeLiveNoteSession('Converged', 'old base');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(updateNote).mockRejectedValueOnce(new Error('write failed'));
    live.editContent('converged content');
    await live.session.flushSave();
    warn.mockRestore();
    expect(live.session.savedContent).toBe('old base');
    expect(live.session.dirty).toBe(true);

    const manager = createSyncManager({
      session: live.session,
      showToast: vi.fn(),
      onRename: vi.fn(),
      pruneTabsForDeletedIds: vi.fn(),
    });

    await manager.handleSyncComplete({ ...emptySummary, updatedIds: ['Converged'] });

    expect(live.getEditorContent()).toBe('converged content');
    expect(live.setEditorContent).not.toHaveBeenCalled();
    expect(live.session.savedContent).toBe('converged content');
    expect(live.session.dirty).toBe(false);
  });

  it('defers a watcher adopt during composition until the editor blurs', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'adopt',
      content: 'FRESH',
    });
    const bundle = makeManager(
      makeSession({ id: 'WatcherFocus', content: 'OLD', focused: true, composing: true }),
    );
    await bundle.manager.handleFileChange({ type: 'change', filename: 'WatcherFocus.md' });
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    bundle.state.composing = false;
    bundle.state.focused = false;
    await bundle.manager.handleEditorFocusChange(false);
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });

  it('adopts watcher and sync content immediately when the editor is not focused', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' });
    const watcher = makeManager(makeSession({ id: 'WatcherBlur', content: 'OLD' }));
    await watcher.manager.handleFileChange({ type: 'change', filename: 'WatcherBlur.md' });
    expect(watcher.applyExternalContent).toHaveBeenCalledWith('FRESH');

    const synced = makeManager(makeSession({ id: 'SyncBlur', content: 'OLD' }));
    await synced.manager.handleSyncComplete({ ...emptySummary, updatedIds: ['SyncBlur'] });
    expect(synced.applyExternalContent).toHaveBeenCalledWith('FRESH');
  });

  it('flushes a draft created while deferred before adopting sync content on blur', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'deferAdopt' })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'FRESH' });
    const bundle = makeManager(makeSession({ id: 'DirtyLater', content: 'OLD', focused: true }));
    await bundle.manager.handleSyncComplete({ ...emptySummary, updatedIds: ['DirtyLater'] });
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();

    bundle.state.focused = false;
    bundle.state.dirty = true;
    bundle.state.content = 'LOCAL';
    vi.mocked(bundle.session.flushSave).mockImplementationOnce(async () => {
      bundle.state.dirty = false;
    });
    await bundle.manager.handleEditorFocusChange(false);

    expect(bundle.session.flushSave).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('FRESH');
    expect(bundle.toasts).toEqual([]);
  });

  it('re-reads a sync-deferred adopt on blur while the sync-write suppressor is active', async () => {
    openNoteMocks.classifyOpenNote
      .mockResolvedValueOnce({ kind: 'deferAdopt' })
      .mockResolvedValueOnce({ kind: 'adopt', content: 'current disk content' });
    const bundle = makeManager(
      makeSession({ id: 'SuppressedSyncAdopt', content: 'OLD', focused: true }),
    );

    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['SuppressedSyncAdopt'],
    });
    expect(writeSuppressor.isRecentSyncWrite('SuppressedSyncAdopt.md')).toBe(true);

    bundle.state.focused = false;
    await bundle.manager.handleEditorFocusChange(false);

    expect(openNoteMocks.classifyOpenNote).toHaveBeenCalledTimes(2);
    expect(bundle.applyExternalContent).toHaveBeenCalledExactlyOnceWith('current disk content');
  });
});

describe('peer deletion safety', () => {
  it('closes a clean deleted open note instead of adopting an empty string', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'close' });
    const bundle = makeManager(makeSession({ id: 'Doomed', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['Doomed'],
      peerDeletedIds: ['Doomed'],
    });
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
    expect(bundle.toasts).toContain('Note was deleted');
  });

  it('keeps an unsaved draft and excludes it from tab pruning', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'keepDraft',
      base: 'base',
      reason: 'peerDeleted',
    });
    const bundle = makeManager(makeSession({ id: 'DirtyDoomed', content: 'LOCAL', dirty: true }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['DirtyDoomed', 'BackgroundGone'],
      peerDeletedIds: ['DirtyDoomed', 'BackgroundGone'],
    });
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['BackgroundGone']);
  });

  it('adopts a deleted-then-recreated note when it still exists on disk', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({
      kind: 'adopt',
      content: '# recreated',
    });
    vi.mocked(noteExists).mockResolvedValue(true);
    const bundle = makeManager(makeSession({ id: 'Recreated', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Recreated'],
      deletedIds: ['Recreated'],
      peerUpdatedIds: ['Recreated'],
      peerDeletedIds: ['Recreated'],
    });
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('# recreated');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  it('closes and prunes an id in both lists when the file is gone', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'close' });
    const bundle = makeManager(makeSession({ id: 'Contested', content: 'MY PUSH' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      uploaded: 1,
      updatedIds: ['Contested'],
      deletedIds: ['Contested'],
      peerDeletedIds: ['Contested'],
    });
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Contested']);
  });

  it('prunes only deleted background notes that are absent on disk', async () => {
    vi.mocked(noteExists).mockImplementation(async (id) => id === 'Recreated');
    const bundle = makeManager();
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      deletedIds: ['Gone', 'Recreated'],
      updatedIds: ['Recreated'],
      peerDeletedIds: ['Gone', 'Recreated'],
      peerUpdatedIds: ['Recreated'],
    });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['Gone']);
  });

  it('keeps the open note and skips pruning when classification and probes reject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openNoteMocks.classifyOpenNote.mockRejectedValueOnce(new Error('vault unavailable'));
    vi.mocked(noteExists).mockRejectedValue(new Error('vault unavailable'));
    const bundle = makeManager(makeSession({ id: 'ProbeError', content: 'OLD' }));
    await expect(
      bundle.manager.handleSyncComplete({
        ...emptySummary,
        deletedIds: ['ProbeError'],
        peerDeletedIds: ['ProbeError'],
      }),
    ).resolves.toBeUndefined();
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
    expect(bundle.pruneTabsForDeletedIds).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('applies the authoritative close verdict without a frontend read/exists race', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'close' });
    const bundle = makeManager(makeSession({ id: 'Vanisher', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Vanisher'],
      deletedIds: ['Vanisher'],
      peerDeletedIds: ['Vanisher'],
    });
    expect(bundle.cancelAndClear).toHaveBeenCalledOnce();
    expect(bundle.applyExternalContent).not.toHaveBeenCalled();
  });

  it('still adopts a legitimately empty recreated note', async () => {
    openNoteMocks.classifyOpenNote.mockResolvedValueOnce({ kind: 'adopt', content: '' });
    vi.mocked(noteExists).mockResolvedValue(true);
    const bundle = makeManager(makeSession({ id: 'EmptyRecreated', content: 'OLD' }));
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['EmptyRecreated'],
      deletedIds: ['EmptyRecreated'],
      peerDeletedIds: ['EmptyRecreated'],
    });
    expect(bundle.applyExternalContent).toHaveBeenCalledWith('');
    expect(bundle.cancelAndClear).not.toHaveBeenCalled();
  });

  it('still prunes other deleted tabs when the active note switches during a read', async () => {
    const bundle = makeManager(makeSession({ id: 'Active', content: 'OLD' }));
    vi.mocked(noteExists).mockImplementation(async (id) => id !== 'OtherGone');
    openNoteMocks.classifyOpenNote.mockImplementationOnce(async () => {
      bundle.state.id = 'Elsewhere';
      return { kind: 'adopt', content: '# fresh' };
    });
    await bundle.manager.handleSyncComplete({
      ...emptySummary,
      updatedIds: ['Active'],
      deletedIds: ['Active', 'OtherGone'],
      peerUpdatedIds: ['Active'],
      peerDeletedIds: ['Active', 'OtherGone'],
    });
    expect(bundle.pruneTabsForDeletedIds).toHaveBeenCalledWith(['OtherGone']);
  });
});
